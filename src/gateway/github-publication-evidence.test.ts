// Install publication I/O fixtures before the registered action owner.
// oxfmt-ignore
import { createPublicationActionFixture as fixture } from "./github-publication-actions.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createSandboxFsBridge } from "../agents/sandbox/fs-bridge.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { setRuntimeConfigSnapshot, writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { LookupFn } from "../infra/net/ssrf.js";
import { encodePngRgb } from "../media/png-encode.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { guestScopes } from "./github-publication-requester.test-support.js";
import {
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  commandResult,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";

const mocks = githubPublicationTestMocks();
const lookup = vi.hoisted(() => vi.fn<LookupFn>());
const publicAddress = { address: "93.184.216.34", family: 4 };
const inspected = (filename: string, bytes: Buffer) => ({
  path: filename,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sizeBytes: bytes.length,
});
const response = (body: unknown, status = 201) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
// Mocked fetch normally skips DNS. Retain real guarded preflight with the isolated lookup.
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({ ...params, lookupFn: lookup }),
  };
});

async function evidenceFixture() {
  const f = await fixture();
  const cwd = f.local!.cwd;
  const bytes = encodePngRgb(Buffer.from([30, 120, 210]), 1, 1);
  await fs.writeFile(path.join(cwd, "proof.png"), bytes);
  const sandbox = createSandboxTestContext({
    overrides: {
      sessionKey: SESSION_KEY,
      workspaceDir: cwd,
      agentWorkspaceDir: cwd,
      containerWorkdir: cwd,
    },
  });
  const { runCommandBuffered } =
    await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  sandbox.fsBridge = createSandboxFsBridge({
    sandbox: {
      ...sandbox,
      backend: {
        runShellCommand: async (params) => {
          const result = await runCommandBuffered(
            ["sh", "-c", params.script, "evidence-fixture", ...(params.args ?? [])],
            {
              input: params.stdin,
              signal: params.signal,
              timeoutMs: 10_000,
            },
          );
          if (result.code !== 0 && !params.allowFailure) {
            throw new Error(result.stderr.toString());
          }
          return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
      },
    },
  });
  const evidence = inspected("proof.png", bytes);
  const profileId = `ghp_${"1".repeat(32)}`;
  mocks.prepareIdentity.mockResolvedValue({
    source: "system-configured",
    profileId,
    account: { accountId: 42, login: "roboclaw-bot", avatarUrl: null },
    env: { GH_TOKEN: "synthetic-evidence-token" },
  });
  const config = { ...f.config, tools: { github: { profileId } } };
  setRuntimeConfigSnapshot(config);
  const actualIdentity = await vi.importActual<typeof import("../agents/github-tool-identity.js")>(
    "../agents/github-tool-identity.js",
  );
  mocks.matchesIdentity.mockImplementation(actualIdentity.matchesPreparedGitHubPublicationIdentity);
  const previous = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv, options) =>
    argv.includes(`repos/${f.publication.repository}`) && argv.includes(".id")
      ? commandResult("12345")
      : previous(argv, options),
  );
  lookup.mockReset().mockResolvedValue([publicAddress]);
  const url = "https://github.com/user-attachments/assets/10000000-0000-4000-8000-000000000001";
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ url }));
  vi.stubGlobal("fetch", fetch);
  onTestFinished(vi.unstubAllGlobals);
  const upload = (input: Record<string, unknown> = {}, client?: typeof f.guestSource.client) =>
    f.invoke(
      "guest",
      { action: "upload_evidence", ...f.expected, evidence, ...input },
      SESSION_KEY,
      { client, sandbox },
    );
  async function denyUpload(message?: string, input: Record<string, unknown> = {}) {
    await expect(upload(input)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  }
  return {
    ...f,
    sandbox,
    bytes,
    evidence,
    url,
    fetch,
    upload,
    denyEvidence: (overrides: Record<string, unknown>, message?: string) =>
      denyUpload(message, { evidence: { ...evidence, ...overrides } }),
    denyUpload,
    config,
    async deselectPublisher() {
      setRuntimeConfigSnapshot(
        await updateGitHubToolIdentityConfig({
          scope: "system",
          agentId: "main",
          expectedIdentity: config.tools.github,
        }),
      );
    },
    onLookup(callback: () => Promise<void>) {
      lookup.mockImplementationOnce(async () => {
        await callback();
        return [publicAddress];
      });
    },
  };
}

describe("workspace evidence through the guest tool and registered publication action", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });
  let f: Awaited<ReturnType<typeof evidenceFixture>>;
  beforeEach(async () => {
    f = await evidenceFixture();
  });

  it("uploads inspected guest workspace bytes and associates the reference only through metadata editing", async () => {
    const body = f.state.body;
    expect((await f.upload()).details).toMatchObject({
      evidence: {
        status: "uploaded",
        url: f.url,
        sha256: f.evidence.sha256,
        sizeBytes: f.bytes.length,
        mimeType: "image/png",
        publicAccess: "unverified",
      },
    });
    expect(f.state.body).toBe(body);
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toContain("https://uploads.github.com/user-attachments/assets?");
    expect(url).toContain("repository_id=12345");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: new Uint8Array(f.bytes),
    });
    await f.invoke("guest", {
      action: "edit",
      ...f.expected,
      expectedBody: body,
      body: `![Proof](${f.url})\n\n${body}`,
    });
    expect(f.state.body).toBe(`![Proof](${f.url})\n\n${body}`);
    expect(f.writes.map((write) => write.action)).toEqual(["edit"]);
  });

  it("rejects foreign paths, altered bytes, unsafe media and unrelated publication selectors before upload", async () => {
    for (const filename of [
      "../foreign.png",
      "/workspace/proof.png",
      "https://example.test/proof.png",
      "unsafe\nname.png",
      "proof.txt",
    ]) {
      await f.denyEvidence({ path: filename });
    }
    await f.denyEvidence({ sha256: "f".repeat(64) }, "bytes changed");
    for (const sizeBytes of [f.bytes.length - 1, 10_000_001]) {
      await f.denyEvidence({ sizeBytes });
    }
    const fake = Buffer.from("<html>private content</html>");
    await fs.writeFile(path.join(f.local!.cwd, "fake.png"), fake);
    await f.denyEvidence(inspected("fake.png", fake), "do not match");
    const foreign = path.join(path.dirname(f.local!.cwd), "foreign.png");
    await fs.writeFile(foreign, f.bytes);
    await fs.symlink(foreign, path.join(f.local!.cwd, "foreign.png"));
    const foreignUpload = f.upload({ evidence: { ...f.evidence, path: "foreign.png" } });
    await expect(foreignUpload).rejects.toThrow(
      "Evidence could not be read from this conversation's workspace; no upload was attempted.",
    );
    for (const privatePath of [f.local!.cwd, path.dirname(f.local!.cwd)]) {
      await expect(foreignUpload).rejects.not.toThrow(privatePath);
    }
    await f.denyUpload(undefined, { publishingSessionKey: "agent:main:foreign" });
    await f.denyUpload("publication changed", { requestId: randomUUID() });
    await f.denyEvidence({ repository: "foreign/repo" });
  });

  it("does not follow redirects or repeat an uncertain evidence write", async () => {
    for (const outcome of [
      new Response(null, { status: 302, headers: { location: "https://foreign.example/upload" } }),
      response("not JSON"),
      response({ url: "https://foreign.example/asset" }),
      response("x".repeat(16 * 1024 + 1)),
      new Error("response lost after write"),
    ]) {
      f.fetch.mockClear();
      if (outcome instanceof Error) {
        f.fetch.mockRejectedValueOnce(outcome);
      } else {
        f.fetch.mockResolvedValueOnce(outcome);
      }
      expect((await f.upload()).details).toMatchObject({ evidence: { status: "unconfirmed" } });
      expect(f.fetch).toHaveBeenCalledOnce();
    }
    expect(f.writes).toEqual([]);
  });

  it("rechecks the real publisher selection after transport preparation before sending evidence", async () => {
    await writeConfigFile(f.config);
    let deselected = false;
    f.onLookup(async () => {
      await f.deselectPublisher();
      deselected = true;
    });
    await f.denyUpload("publisher changed");
    expect(deselected).toBe(true);
  });

  it("warns about an uncertain write when publisher authority is lost after dispatch", async () => {
    await writeConfigFile(f.config);
    f.fetch.mockImplementationOnce(async () => {
      await f.deselectPublisher();
      return response({ url: f.url });
    });
    await expect(f.upload()).rejects.toThrow("GitHub may have created the attachment");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("denies evidence publication to an admitted shared-session participant who is not its creator", async () => {
    const participant = await ensureCanonicalUserProfileForEmail(
      "publication-evidence-peer@example.test",
    );
    const client = createOperatorWsClient({ connId: participant.id, scopes: [...guestScopes] });
    client.authenticatedUserProfile = {
      ...f.guestSource.client.authenticatedUserProfile!,
      profileId: participant.id,
    };
    prepareGatewayConnectOperatorAccess(client);
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    await upsertSessionEntryCore(scope, { visibility: "shared" });
    addSessionMember(scope, { identityId: participant.id, addedBy: f.guestProfile });
    const admission = await resolveSessionMutationAuthorizationAsync({
      client,
      context: Object.assign(createRequestContext(), f.guestSource.context),
      method: "sessions.patch",
      requestParams: { key: SESSION_KEY, label: "Shared work" },
    });
    try {
      expect(admission.error).toBeNull();
      expect(admission.authorization).toBeDefined();
      admission.authorization!.assertCurrent();
      await expect(f.upload({}, client)).rejects.toThrow(
        "The original GitHub publication requester is no longer authorized.",
      );
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      admission.authorization?.release?.();
    }
  });

  it("rechecks PR head and the guest's current role after evidence preparation", async () => {
    let reads = 0;
    f.onRead(async () => {
      if (++reads === 2) {
        f.state.head.sha = "f".repeat(40);
      }
    });
    await expect(f.upload()).rejects.toThrow("head changed");
    f.state.head.sha = f.publication.headCommit;
    reads = 0;
    f.onRead(async () => {
      if (++reads === 2) {
        await f.revoke();
      }
    });
    await f.denyUpload("Your operator role changed");
  });

  it("retains session authority across the actual workspace byte read", async () => {
    const bridge = f.sandbox.fsBridge!;
    const read = bridge.readFileWithSource!.bind(bridge);
    const readSpy = vi
      .spyOn(bridge, "readFileWithSource")
      .mockImplementationOnce(async (params) => {
        const bytes = await read(params);
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: SESSION_KEY },
          { archivedAt: Date.now() },
        );
        return bytes;
      });
    await f.denyUpload();
    expect(readSpy).toHaveBeenCalledOnce();
  });
});
