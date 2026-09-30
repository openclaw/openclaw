import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetDeclared,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { resolveManagedGitHubProfileDir } from "../../agents/github-tool-identity.js";
import { createTestBoardStore } from "../../boards/board-store.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import * as processExec from "../../process/exec.js";
import * as lazyPromise from "../../shared/lazy-promise.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { toRequestUrl } from "../../test-utils/provider-usage-fetch.js";
import { drainSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { gitHubPublicApi } from "../github-public-api.js";
import { createBoardHarness } from "./board.test-support.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const profileId = "ghp_11111111111111111111111111111111";
const token = "synthetic-board-token";
const run = {
  id: 1,
  name: "CI",
  display_title: "Fix",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/owner/repo/actions/runs/1",
  run_started_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  event: "push",
  workflow_id: 2,
  run_attempt: 1,
};
const result = { total_count: 1, workflow_runs: [run] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const commandResult = (value = "", code = 0) => ({
  stdout: Buffer.from(value),
  stderr: Buffer.alloc(0),
  code,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

const getOrCreatePromise = lazyPromise.getOrCreatePromise;

function observeSharedReadAdmission() {
  const joined = createDeferred();
  vi.spyOn(lazyPromise, "getOrCreatePromise").mockImplementation((cache, key, create, options) => {
    const pending = cache.get(key);
    const shared = getOrCreatePromise(cache, key, create, options);
    // Credential verification precedes filesystem awaits; wait for actual singleflight admission.
    if (pending === shared) {
      joined.resolve();
    }
    return shared;
  });
  return joined.promise;
}

describe("board authenticated GitHub Actions", () => {
  let state: OpenClawTestState;
  let boardStore: ReturnType<typeof createTestBoardStore>;
  let caseNumber = 0;
  let config: OpenClawConfig;
  let actions: () => Response | Promise<Response>;
  let http: Mock<typeof fetch>;
  const account = vi.fn(async () => json({ id: 100, login: "fixture-user", avatar_url: null }));
  const native = vi.fn<typeof processExec.runCommandBuffered>();
  const credentialDirs = new Set<string>();

  const boardSessionKey = (agentId = "main") => `agent:${agentId}:runs-${caseNumber}`;

  beforeAll(async () => {
    state = await createOpenClawTestState({
      prefix: "board-github-",
      env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
    });
    // Keep the real database workers prepared; each case owns distinct session rows.
    boardStore = createTestBoardStore({ stateDir: state.stateDir });
  });

  afterAll(async () => {
    await state?.cleanup();
  });

  async function writeCredential(
    scope: "system" | "agent",
    id: string,
    credential: string,
    agentId = "main",
  ) {
    const profile = resolveManagedGitHubProfileDir({ agentId, scope, profileId: id });
    credentialDirs.add(profile);
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(profile, "hosts.yml"),
      `github.com:\n  oauth_token: ${credential}\n`,
      { mode: 0o600 },
    );
  }

  beforeEach(async () => {
    caseNumber += 1;
    resetPluginRuntimeStateForTest();
    clearGitHubCredentialVerificationCache();
    state.envVars.GH_TOKEN = undefined;
    state.envVars.GITHUB_TOKEN = undefined;
    state.applyEnv();
    config = {
      agents: { entries: { main: { default: true } } },
      tools: { exec: { mode: "full" }, github: { profileId } },
      gateway: { controlUi: { github: { token: "synthetic-preview-only" } } },
    };
    await writeCredential("system", profileId, token);
    native.mockReset().mockRejectedValue(new Error("Unexpected native credential subprocess"));
    vi.spyOn(processExec, "runCommandBuffered").mockImplementation(native);
    actions = () => json(result);
    account
      .mockReset()
      .mockImplementation(async () => json({ id: 100, login: "fixture-user", avatar_url: null }));
    // Each test owns an independent GitHub transport, including its quota state.
    http = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        toRequestUrl(url).endsWith("/user") ? account() : actions(),
      );
    vi.stubGlobal("fetch", http);
  });

  function createGitHubBoardHarness() {
    return createBoardHarness(undefined, {}, boardStore, {
      getRuntimeConfig: () => config,
    });
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetPluginRuntimeStateForTest();
    await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    for (const profile of credentialDirs) {
      await fs.rm(profile, { recursive: true, force: true });
    }
    credentialDirs.clear();
  });

  async function reader(
    options: {
      declared?: BoardWidgetDeclared;
      harness?: ReturnType<typeof createBoardHarness>;
      name?: string;
      agentId?: string;
    } = {},
  ) {
    const harness = options.harness ?? createGitHubBoardHarness();
    const name = options.name ?? "runs";
    const sessionKey = boardSessionKey(options.agentId);
    await harness.invoke("board.widget.put", {
      sessionKey,
      name,
      content: { kind: "html", html: "runs" },
      declared: options.declared ?? { tools: ["github.actions.runs:Owner/Repo"] },
    });
    const board = await harness.invoke("board.get", { sessionKey });
    const snapshot = board.mock.calls[0]![1] as BoardSnapshot;
    const widget = snapshot.widgets.find((candidate) => candidate.name === name)!;
    return {
      ...harness,
      harness,
      widget,
      read: (params: Record<string, unknown> = { repository: "owner/repo" }) =>
        harness.invoke("board.data.read", {
          ticket: widget.viewTicket,
          bindingId: "github.actions.runs",
          params,
        }),
    };
  }
  const actionCalls = () => http.mock.calls.filter(([url]) => !toRequestUrl(url).endsWith("/user"));

  it("verifies identity before saving registered host capabilities and preserves a failed update", async () => {
    const registry = createEmptyPluginRegistry();
    createPluginBoardWidgetContentKindRegistrar(registry)(
      createPluginRecord({
        id: "fixture",
        source: "fixture",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      }),
      {
        kind: "fixture",
        label: "Fixture",
        resources: { surface: "fixture", paths: ["/widget.js"] },
        validateSource: () => {},
        composeDocument: ({ source }) => source,
      },
    );
    setActivePluginRegistry(registry);
    const { invoke, store, broadcast } = createGitHubBoardHarness();
    const target = { sessionKey: boardSessionKey(), agentId: "main" };
    const input = {
      ...target,
      name: "runs",
      content: { kind: "registered", contentKind: "fixture", source: "runs" },
      declared: { tools: ["github.actions.runs:Owner/Repo"] },
    };
    expect((await invoke("board.widget.put", input)).mock.calls[0]?.[0]).toBe(true);
    expect(account).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
    expect(actionCalls()).toHaveLength(0);
    const before = await store.getSnapshot(target);
    expect(before.widgets[0]?.declared?.tools).toEqual(["github.actions.runs:owner/repo"]);
    broadcast.mockClear();
    clearGitHubCredentialVerificationCache();
    account.mockImplementationOnce(async () => new Response(token, { status: 401 }));
    const denied = await invoke("board.widget.put", input);
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(denied.mock.calls[0]?.[2]?.message).toMatch(/reconnect|retry/);
    expect(JSON.stringify(denied.mock.calls)).not.toContain(token);
    expect(await store.getSnapshot(target)).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["signal", "commit guard", "session authorization", "agent", "routing"] as const)(
    "rejects pinning when %s authority changes during verification without persistence",
    async (changed) => {
      const { handlers, context, store, broadcast } = createGitHubBoardHarness();
      const target = { sessionKey: boardSessionKey(), agentId: "main" };
      const before = await store.getSnapshot(target);
      const controller = new AbortController();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Caller authority retired");
        }
      };
      const respond = vi.fn<RespondFn>();
      const input = {
        ...target,
        name: "runs",
        content: { kind: "html", html: "runs" },
        declared: { tools: ["github.actions.runs:owner/repo"] },
      };
      const invocation: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "pin", method: "board.widget.put", params: input },
        params: input,
        client: null,
        isWebchatConnect: () => false,
        respond,
        context,
        signal: controller.signal,
        ...(changed === "commit guard" ? { sessionMutationCommitGuard: assertCurrent } : {}),
        ...(changed === "session authorization"
          ? { sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent } }
          : {}),
      };
      account.mockImplementationOnce(async () => {
        current = false;
        if (changed === "signal") {
          controller.abort();
        }
        if (changed === "agent") {
          config.agents = { entries: { other: { default: true } } };
        }
        if (changed === "routing") {
          config.session = { scope: "global", mainKey: `runs-${caseNumber}` };
        }
        return json({ id: 100, login: "fixture-user", avatar_url: null });
      });
      await handlers["board.widget.put"]!(invocation);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(await store.getSnapshot(target)).toEqual(before);
      expect(broadcast).not.toHaveBeenCalled();
      expect(actionCalls()).toHaveLength(0);
    },
  );

  it("rejects another repository's grant before preparing credentials", async () => {
    const { read } = await reader({ declared: { tools: ["github.actions.runs:owner/other"] } });
    const callsBeforeRead = http.mock.calls.length;
    const response = await read();
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]?.message).toContain("not granted");
    expect(http).toHaveBeenCalledTimes(callsBeforeRead);
  });

  it("rejects malformed or authority-overriding params without changing a usable board", async () => {
    const { read, store } = await reader();
    const target = { sessionKey: boardSessionKey(), agentId: "main" };
    const before = await store.getSnapshot(target);
    const callsBeforeRead = http.mock.calls.length;
    for (const invalid of [
      { repository: "../repo" },
      { repository: "owner/repo/extra" },
      { repository: "owner/.." },
      { perPage: 0 },
      { perPage: 31 },
      { perPage: 1.5 },
      { workflow: "../ci.yml" },
      { branch: "main\n" },
      { branch: `bad${String.fromCharCode(0)}branch` },
      { branch: `bad${String.fromCharCode(0x7f)}branch` },
      { created: "2026-02-30" },
      { status: "unknown" },
      { excludePullRequests: "true" },
      ...["agentId", "profile", "token", "headers", "url", "method", "maxBytes"].map((field) => ({
        [field]: "forbidden",
      })),
    ]) {
      const response = await read({ repository: "owner/repo", ...invalid });
      expect(response.mock.calls[0], JSON.stringify(invalid)).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("Invalid GitHub Actions parameters"),
        }),
      ]);
      expect(http).toHaveBeenCalledTimes(callsBeforeRead);
    }
    expect(await store.getSnapshot(target)).toEqual(before);
    expect((await read()).mock.calls[0]).toEqual([true, result]);
    expect(actionCalls()).toHaveLength(1);
  });

  it("does not follow redirects to another repository", async () => {
    const location = "https://api.github.com/repos/owner/other/actions/runs";
    actions = () => new Response(null, { status: 302, headers: { location } });
    const { read } = await reader();
    const response = await read();
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(actionCalls()).toHaveLength(1);
    expect(JSON.stringify(response.mock.calls)).not.toContain(token);
  });

  it("accepts thirty large raw runs under 1MiB, projects them, and retains the shared 256KiB default", async () => {
    const runs = Array.from({ length: 30 }, () => ({
      ...run,
      repository: { description: "x".repeat(12_000) },
    }));
    const raw = { total_count: 30, workflow_runs: runs };
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(256 * 1024);
    await expect(gitHubPublicApi.readGitHubJsonResponse(json(raw))).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("size limit"),
    });
    actions = () => json(raw);
    const { read } = await reader();
    expect((await read({ repository: "owner/repo", perPage: 30 })).mock.calls[0]).toEqual([
      true,
      { total_count: 30, workflow_runs: Array.from({ length: 30 }, () => run) },
    ]);
    actions = () => json({ ...raw, extra: "x".repeat(1024 * 1024) });
    expect(
      (await read({ repository: "owner/repo", perPage: 30, branch: "large" })).mock.calls[0]?.[0],
    ).toBe(false);
  });

  it.each([
    { total_count: -1, workflow_runs: [] },
    { total_count: 1, workflow_runs: [{ ...run, html_url: "https://example.test/" }] },
    { total_count: 1, workflow_runs: [{ ...run, display_title: token }] },
  ])("rejects an unsafe upstream projection", async (raw) => {
    actions = () => json(raw);
    const response = await (await reader()).read();
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(response.mock.calls)).not.toContain(token);
  });

  it.each([
    { status: 403, headers: undefined, message: "access denied" },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      message: "rate limited",
      cooldownMs: 60_000,
    },
    { status: 401, headers: undefined, message: "reconnect" },
    { status: 500, headers: undefined, message: "request failed" },
  ])(
    "sanitizes HTTP $status without anonymous retry ($message)",
    async ({ status, headers, message, cooldownMs }) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      actions = () => new Response(token, { status, headers });
      const { read } = await reader();
      const response = await read();
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[2]?.message).toContain(message);
      expect(JSON.stringify(response.mock.calls)).not.toContain(token);
      expect(actionCalls()).toHaveLength(1);
      actions = () => json(result);
      if (cooldownMs) {
        expect((await read()).mock.calls[0]?.[2]?.message).toContain("rate limited");
        expect(actionCalls()).toHaveLength(1);
        clock.mockReturnValue(now + cooldownMs);
      }
      expect((await read()).mock.calls[0]).toEqual([true, result]);
      expect(actionCalls()).toHaveLength(2);
    },
  );

  it("does not start an Actions read after its widget is removed during credential preparation", async () => {
    delete config.tools!.github;
    native.mockImplementation(async () => commandResult(token));
    const { read, invoke } = await reader();
    // Pinning warmed native auth; this case needs an actual delayed credential read.
    clearGitHubCredentialVerificationCache();
    const started = createDeferred();
    const release = createDeferred();
    native.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return commandResult(token);
    });
    const pending = read();
    try {
      expect(
        await Promise.race([started.promise.then(() => "reading"), pending.then(() => "done")]),
      ).toBe("reading");
      await invoke("board.update", {
        sessionKey: boardSessionKey(),
        ops: [{ kind: "widget_remove", name: "runs" }],
      });
    } finally {
      release.resolve();
    }
    expect((await pending).mock.calls[0]?.[0]).toBe(false);
    expect(actionCalls()).toHaveLength(0);
  });

  it("coalesces successful reads and scopes cache entries to filters and current credentials", async () => {
    const started = createDeferred();
    const release = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const { read } = await reader();
    const first = read();
    const second = read();
    await started.promise;
    release.resolve();
    expect((await first).mock.calls[0]).toEqual([true, result]);
    expect((await second).mock.calls[0]).toEqual([true, result]);
    expect((await read()).mock.calls[0]).toEqual([true, result]);
    expect(actionCalls()).toHaveLength(1);
    const [url, init] = actionCalls()[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/actions/runs?per_page=20&exclude_pull_requests=true",
    );
    expect(init?.method ?? "GET").toBe("GET");
    expect(init).toMatchObject({
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(http.mock.calls)).not.toContain("synthetic-preview-only");
    await read({ repository: "owner/repo", branch: "other" });
    expect(actionCalls()).toHaveLength(2);
    await writeCredential("system", profileId, "synthetic-rotated-token");
    await read();
    expect(actionCalls()).toHaveLength(3);
    expect(actionCalls()[2]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer synthetic-rotated-token" },
    });
    const freshGateway = await reader();
    await freshGateway.read();
    expect(actionCalls()).toHaveLength(4);
  });

  it("rejects changed session ownership across an awaited fetch", async () => {
    const started = createDeferred();
    const release = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const { read } = await reader();
    const pending = read();
    await started.promise;
    config.agents = { entries: { other: { default: true } } };
    release.resolve();
    expect((await pending).mock.calls[0]?.[0]).toBe(false);
  });

  it("isolates a removed leader from the surviving shared read and rechecks cached authority", async () => {
    const removed = "leader";
    const leader = await reader({ name: "leader" });
    const follower = await reader({ harness: leader.harness, name: "follower" });
    const started = createDeferred();
    const release = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const leaderRead = leader.read();
    await started.promise;
    const joined = observeSharedReadAdmission();
    const followerRead = follower.read();
    await joined;
    await leader.invoke("board.update", {
      sessionKey: boardSessionKey(),
      ops: [{ kind: "widget_remove", name: removed }],
    });
    release.resolve();
    const responses = { leader: await leaderRead, follower: await followerRead };
    const surviving = "follower";
    expect(responses[removed].mock.calls[0]).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "board widget view ticket is stale",
      }),
    ]);
    expect(responses[surviving].mock.calls[0]).toEqual([true, result]);
    expect(actionCalls()).toHaveLength(1);
    const survivor = follower;
    expect((await survivor.read()).mock.calls[0]).toEqual([true, result]);
    expect(actionCalls()).toHaveLength(1);
    clearGitHubCredentialVerificationCache();
    account.mockImplementationOnce(async () => {
      await survivor.invoke("board.update", {
        sessionKey: boardSessionKey(),
        ops: [{ kind: "widget_remove", name: surviving }],
      });
      return json({ id: 100, login: "fixture-user", avatar_url: null });
    });
    expect((await survivor.read()).mock.calls[0]?.[0]).toBe(false);
    expect(actionCalls()).toHaveLength(1);
  });

  it("keeps shared transport available after a removed leader exits while a follower revalidates", async () => {
    delete config.tools!.github;
    native.mockImplementation(async () => commandResult(token));
    const leader = await reader({ name: "leader" });
    const follower = await reader({ harness: leader.harness, name: "follower" });
    const third = await reader({ harness: leader.harness, name: "third" });
    const started = createDeferred();
    const release = createDeferred();
    const rereading = createDeferred();
    const resume = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const leaderRead = leader.read();
    await started.promise;
    const joined = observeSharedReadAdmission();
    const followerRead = follower.read();
    await joined;
    await leader.invoke("board.update", {
      sessionKey: boardSessionKey(),
      ops: [{ kind: "widget_remove", name: "leader" }],
    });
    clearGitHubCredentialVerificationCache();
    native.mockImplementationOnce(async () => {
      rereading.resolve();
      await resume.promise;
      return commandResult(token);
    });
    release.resolve();
    try {
      expect(
        await Promise.race([
          rereading.promise.then(() => "reading"),
          followerRead.then(() => "done"),
        ]),
      ).toBe("reading");
      expect((await leaderRead).mock.calls[0]?.[0]).toBe(false);
      const nativeJoined = observeSharedReadAdmission();
      const thirdRead = third.read();
      // Native revalidation is shared too; both surviving callers await this lookup.
      expect(
        await Promise.race([nativeJoined.then(() => "joined"), thirdRead.then(() => "done")]),
      ).toBe("joined");
      resume.resolve();
      expect((await thirdRead).mock.calls[0]).toEqual([true, result]);
      expect(actionCalls()).toHaveLength(1);
    } finally {
      resume.resolve();
      await followerRead;
    }
    expect((await followerRead).mock.calls[0]).toEqual([true, result]);
  });

  it("bounds concurrent callers without retaining failed work", async () => {
    const started = createDeferred();
    const release = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const { read } = await reader();
    const pending = Array.from({ length: 32 }, () => read());
    await started.promise;
    expect((await read()).mock.calls[0]?.[2]?.message).toContain("busy");
    release.resolve();
    expect(
      (await Promise.all(pending)).every((response) => response.mock.calls[0]?.[0] === true),
    ).toBe(true);
    expect((await read()).mock.calls[0]?.[0]).toBe(true);
  });
});
