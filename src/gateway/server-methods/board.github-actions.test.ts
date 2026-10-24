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
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { resolveManagedGitHubProfileDir } from "../../agents/github-tool-identity.js";
import { createTestBoardStore } from "../../boards/board-store.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import * as processExec from "../../process/exec.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
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
const accountResponse = () => json({ id: 100, login: "fixture-user", avatar_url: null });
type BoardResponse = ReturnType<ReturnType<typeof createBoardHarness>["invoke"]>;
async function expectResult(pending: BoardResponse, payload: unknown = result) {
  expect((await pending).mock.calls[0]).toEqual([true, payload]);
}
async function expectDenied(pending: BoardResponse, message?: string | RegExp, code?: string) {
  const response = await pending;
  expect(response.mock.calls[0]?.[0]).toBe(false);
  if (message !== undefined) {
    expect(response.mock.calls[0]?.[2]?.message).toMatch(message);
  }
  if (code !== undefined) {
    expect(response.mock.calls[0]).toEqual([
      false,
      undefined,
      expect.objectContaining({ code, message }),
    ]);
  }
  expect(JSON.stringify(response.mock.calls)).not.toContain(token);
}
async function expectWaiting(started: Promise<unknown>, pending: Promise<unknown>) {
  expect(await Promise.race([started.then(() => "waiting"), pending.then(() => "done")])).toBe(
    "waiting",
  );
}
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
  const account = vi.fn(async () => accountResponse());
  const native = vi.fn<typeof processExec.runCommandBuffered>();
  const workScopes: AsyncWorkScope[] = [];

  const boardSessionKey = (agentId = "main") => `agent:${agentId}:runs-${caseNumber}`;
  const boardTarget = () => ({ sessionKey: boardSessionKey(), agentId: "main" });
  const widgetInput = () => ({
    sessionKey: boardSessionKey(),
    name: "runs",
    content: { kind: "html", html: "runs" },
    declared: { tools: ["github.actions.runs:Owner/Repo"] },
  });

  beforeAll(async () => {
    state = await createOpenClawTestState({
      prefix: "board-github-",
      env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
    });
    boardStore = createTestBoardStore({ stateDir: state.stateDir });
  });

  afterAll(() => state?.cleanup());

  const credentialDir = () =>
    resolveManagedGitHubProfileDir({ agentId: "main", scope: "system", profileId });
  async function writeCredential(credential: string) {
    const profile = credentialDir();
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
    state.envVars.GH_HOST = undefined;
    state.envVars.GH_ENTERPRISE_TOKEN = undefined;
    state.envVars.GITHUB_ENTERPRISE_TOKEN = undefined;
    state.applyEnv();
    config = {
      agents: { entries: { main: {} } },
      tools: { exec: { mode: "full" }, github: { profileId } },
      gateway: { controlUi: { github: { token: "synthetic-preview-only" } } },
    };
    await writeCredential(token);
    native.mockReset().mockRejectedValue(new Error("Unexpected native credential subprocess"));
    vi.spyOn(processExec, "runCommandBuffered").mockImplementation(native);
    actions = () => json(result);
    account.mockReset().mockImplementation(async () => accountResponse());
    http = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        toRequestUrl(url).endsWith("/user") ? account() : actions(),
      );
    vi.stubGlobal("fetch", http);
  });

  function createGitHubBoardHarness() {
    const work = new AsyncWorkScope();
    workScopes.push(work);
    return createBoardHarness(undefined, {}, boardStore, {
      getRuntimeConfig: () => config,
      trackExecution: (execute) => work.track(execute),
    });
  }
  afterEach(async () => {
    await Promise.all(workScopes.splice(0).map((work) => work.drain()));
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetPluginRuntimeStateForTest();
    await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    await fs.rm(credentialDir(), { recursive: true, force: true });
  });

  async function reader(
    harness = createGitHubBoardHarness(),
    name = "runs",
    agentId = "main",
    repository = "Owner/Repo",
  ) {
    const sessionKey = boardSessionKey(agentId);
    const saved = await harness.invoke("board.widget.put", {
      ...widgetInput(),
      sessionKey,
      name,
      declared: { tools: [`github.actions.runs:${repository}`] },
    });
    expect(saved.mock.calls[0]?.[0], JSON.stringify(saved.mock.calls[0]?.[2])).toBe(true);
    const board = await harness.invoke("board.get", { sessionKey });
    const snapshot = board.mock.calls[0]![1] as BoardSnapshot;
    const widget = snapshot.widgets.find((candidate) => candidate.name === name)!;
    return {
      ...harness,
      read: (params: Record<string, unknown> = { repository: "owner/repo" }) =>
        harness.invoke("board.data.read", {
          ticket: widget.viewTicket,
          bindingId: "github.actions.runs",
          params,
        }),
    };
  }
  const actionCalls = () => http.mock.calls.filter(([url]) => !toRequestUrl(url).endsWith("/user"));
  function holdActions(next = () => json(result)) {
    const held = hold(next);
    actions = held.execute;
    return held;
  }
  function useNativeCredentials() {
    delete config.tools!.github;
    native.mockImplementation(async () => commandResult(token));
  }
  function holdNativeCredentials() {
    clearGitHubCredentialVerificationCache();
    const held = hold(() => commandResult(token));
    native.mockImplementationOnce(held.execute);
    return held;
  }
  function hold<T>(next: () => T) {
    const started = createDeferred();
    const release = createDeferred();
    const execute = async () => {
      started.resolve();
      await release.promise;
      return next();
    };
    return { started, release, execute };
  }
  const removeWidget = (
    harness: Pick<ReturnType<typeof createBoardHarness>, "invoke">,
    name = "runs",
  ) =>
    harness.invoke("board.update", {
      sessionKey: boardSessionKey(),
      ops: [{ kind: "widget_remove", name }],
    });
  async function removeSharedLeader(
    leader: Awaited<ReturnType<typeof reader>>,
    follower: Awaited<ReturnType<typeof reader>>,
  ) {
    const { started, release } = holdActions();
    const leaderRead = leader.read();
    await started.promise;
    const joined = observeSharedReadAdmission();
    const followerRead = follower.read();
    await joined;
    await removeWidget(leader, "leader");
    return { release, leaderRead, followerRead };
  }
  async function sharedReaders(nativeCredentials = false) {
    if (nativeCredentials) {
      useNativeCredentials();
    }
    const leader = await reader(createGitHubBoardHarness(), "leader");
    const follower = await reader(leader, "follower");
    return { leader, follower };
  }

  it.each(["managed", "native environment", "native CLI"])(
    "keeps public Actions credentials and transport together with Enterprise selected (%s)",
    async (source) => {
      config.gateway!.github = {
        host: "ghe.example.test",
        apiBaseUrl: "https://ghe.example.test/api/v3",
      };
      if (source !== "managed") {
        delete config.tools!.github;
      }
      state.envVars.GH_TOKEN = source === "native environment" ? token : undefined;
      state.envVars.GH_HOST = "ghe.example.test";
      state.envVars.GH_ENTERPRISE_TOKEN = "synthetic-enterprise-only";
      state.applyEnv();
      native.mockImplementation(async (argv) =>
        commandResult(argv.at(-1) === "github.com" ? token : "synthetic-wrong-host"),
      );
      setRuntimeConfigSnapshot(config);

      const { read } = await reader();
      await expectResult(read());
      expect(http).toHaveBeenCalledTimes(2);
      for (const [url, init] of http.mock.calls) {
        expect(new URL(toRequestUrl(url)).origin).toBe("https://api.github.com");
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      }
      if (source === "native CLI") {
        expect(native).toHaveBeenCalledWith(
          ["gh", "auth", "token", "--hostname", "github.com"],
          expect.any(Object),
        );
      } else {
        expect(native).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["signal", "commit guard", "session authorization", "agent", "routing"] as const)(
    "rejects pinning when %s authority changes during verification without persistence",
    async (changed) => {
      const { handlers, context, store, broadcast } = createGitHubBoardHarness();
      const target = boardTarget();
      const before = await store.getSnapshot(target);
      const controller = new AbortController();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Caller authority retired");
        }
      };
      const respond = vi.fn<RespondFn>();
      const input = { ...widgetInput(), ...target };
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
          config.agents = { entries: { other: {} } };
        }
        if (changed === "routing") {
          config.session = { scope: "global", mainKey: `runs-${caseNumber}` };
        }
        return accountResponse();
      });
      await handlers["board.widget.put"]!(invocation);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(await store.getSnapshot(target)).toEqual(before);
      expect(broadcast).not.toHaveBeenCalled();
      expect(actionCalls()).toHaveLength(0);
    },
  );

  it("rejects another repository's grant before preparing credentials", async () => {
    const { read } = await reader(undefined, undefined, undefined, "owner/other");
    const callsBeforeRead = http.mock.calls.length;
    await expectDenied(read(), "not granted");
    expect(http).toHaveBeenCalledTimes(callsBeforeRead);
  });

  it("rejects malformed or authority-overriding params without changing a usable board", async () => {
    const { read, store } = await reader();
    const target = boardTarget();
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
    await expectResult(read());
    expect(actionCalls()).toHaveLength(1);
  });

  it("does not follow redirects to another repository", async () => {
    const location = "https://api.github.com/repos/owner/other/actions/runs";
    actions = () => new Response(null, { status: 302, headers: { location } });
    const { read } = await reader();
    await expectDenied(read());
    expect(actionCalls()).toHaveLength(1);
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
    await expectResult(read({ repository: "owner/repo", perPage: 30 }), {
      total_count: 30,
      workflow_runs: Array.from({ length: 30 }, () => run),
    });
    actions = () => json({ ...raw, extra: "x".repeat(1024 * 1024) });
    await expectDenied(read({ repository: "owner/repo", perPage: 30, branch: "large" }));
  });

  it.each([
    { total_count: -1, workflow_runs: [] },
    { total_count: 1, workflow_runs: [{ ...run, html_url: "https://example.test/" }] },
    { total_count: 1, workflow_runs: [{ ...run, display_title: token }] },
  ])("rejects an unsafe upstream projection", async (raw) => {
    actions = () => json(raw);
    await expectDenied((await reader()).read());
  });

  it.each([
    [403, undefined, "access denied", 0],
    [403, { "x-ratelimit-remaining": "0" }, "rate limited", 60_000],
    [401, undefined, "reconnect", 0],
    [500, undefined, "request failed", 0],
  ] as const)(
    "sanitizes HTTP %s without anonymous retry (%s, %s)",
    async (status, headers, message, cooldownMs) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      actions = () => new Response(token, { status, headers });
      const { read } = await reader();
      await expectDenied(read(), message);
      expect(actionCalls()).toHaveLength(1);
      actions = () => json(result);
      if (cooldownMs) {
        expect((await read()).mock.calls[0]?.[2]?.message).toContain("rate limited");
        expect(actionCalls()).toHaveLength(1);
        clock.mockReturnValue(now + cooldownMs);
      }
      await expectResult(read());
      expect(actionCalls()).toHaveLength(2);
    },
  );

  it("does not start an Actions read after its widget is removed during credential preparation", async () => {
    useNativeCredentials();
    const { read, invoke } = await reader();
    const { started, release } = holdNativeCredentials();
    const pending = read();
    try {
      await expectWaiting(started.promise, pending);
      await removeWidget({ invoke });
    } finally {
      release.resolve();
    }
    await expectDenied(pending);
    expect(actionCalls()).toHaveLength(0);
  });

  it("coalesces successful reads and scopes cache entries to filters and current credentials", async () => {
    const { started, release } = holdActions();
    const harness = createGitHubBoardHarness();
    const { read } = await reader(harness);
    config.agents!.entries!.other = {};
    const otherSession = await reader(harness, "runs", "other");
    const sharedSecond = otherSession.read();
    const first = read();
    const second = read();
    await started.promise;
    release.resolve();
    await Promise.all([first, second, sharedSecond].map((pending) => expectResult(pending)));
    await expectResult(otherSession.read());
    await expectResult(read());
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
    await writeCredential("synthetic-rotated-token");
    await read();
    expect(actionCalls()).toHaveLength(3);
    expect(actionCalls()[2]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer synthetic-rotated-token" },
    });
    const freshGateway = await reader();
    await freshGateway.read();
    expect(actionCalls()).toHaveLength(4);
  });

  it.for(["success", "failure"] as const)(
    "returns expired Actions while one background refresh settles with %s",
    async (outcome, { signal }) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const { read } = await reader();
      await expectResult(read());
      clock.mockReturnValue(now + 30_001);
      const updated = { ...result, workflow_runs: [{ ...run, conclusion: "failure" }] };
      const { started, release } = holdActions(() =>
        outcome === "success" ? json(updated) : new Response(token, { status: 503 }),
      );
      const pending = read();
      try {
        await withinTest(started.promise, signal);
        await expectResult(withinTest(pending, signal), { ...result, stale: true });
        await expectResult(read(), { ...result, stale: true });
        expect(actionCalls()).toHaveLength(2);
      } finally {
        release.resolve();
        await pending;
        await AsyncWorkScope.runWhenAllIdle(
          () => workScopes,
          async () => {},
        );
      }
      const response = await read();
      if (outcome === "success") {
        expect(response.mock.calls[0]).toEqual([true, updated]);
        expect(actionCalls()).toHaveLength(2);
      } else {
        await expectDenied(Promise.resolve(response), "request failed");
        expect(actionCalls()).toHaveLength(3);
      }
    },
  );

  it.each(["session ownership", "token"] as const)(
    "rejects changed %s across an awaited fetch",
    async (changed) => {
      const { started, release } = holdActions();
      const { read } = await reader();
      const pending = read();
      await started.promise;
      if (changed === "token") {
        await writeCredential("synthetic-rotated-token");
      } else {
        config.agents = { entries: { other: {} } };
      }
      release.resolve();
      await expectDenied(pending);
    },
  );

  it("isolates a removed leader from the surviving shared read and rechecks cached authority", async () => {
    const { leader, follower } = await sharedReaders();
    const { release, leaderRead, followerRead } = await removeSharedLeader(leader, follower);
    release.resolve();
    await expectDenied(leaderRead, "board widget view ticket is stale", "INVALID_REQUEST");
    await expectResult(followerRead);
    expect(actionCalls()).toHaveLength(1);
    await expectResult(follower.read());
    expect(actionCalls()).toHaveLength(1);
    clearGitHubCredentialVerificationCache();
    account.mockImplementationOnce(async () => {
      await removeWidget(follower, "follower");
      return accountResponse();
    });
    await expectDenied(follower.read());
    expect(actionCalls()).toHaveLength(1);
  });

  it("keeps shared transport available after a removed leader exits while a follower revalidates", async () => {
    const { leader, follower } = await sharedReaders(true);
    const third = await reader(leader, "third");
    const { release, leaderRead, followerRead } = await removeSharedLeader(leader, follower);
    const { started: rereading, release: resume } = holdNativeCredentials();
    release.resolve();
    try {
      await expectWaiting(rereading.promise, followerRead);
      await expectDenied(leaderRead);
      const nativeJoined = observeSharedReadAdmission();
      const thirdRead = third.read();
      await expectWaiting(nativeJoined, thirdRead);
      resume.resolve();
      await expectResult(thirdRead);
      expect(actionCalls()).toHaveLength(1);
    } finally {
      resume.resolve();
      await followerRead;
    }
    await expectResult(followerRead);
  });

  it("bounds concurrent callers without retaining failed work", async () => {
    const { started, release } = holdActions();
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
