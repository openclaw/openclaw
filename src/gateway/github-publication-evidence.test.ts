// Install publication I/O fixtures before the registered action owner.
// oxfmt-ignore
import { createPublicationActionFixture as fixture } from "./github-publication-actions.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createSandboxFsBridge } from "../agents/sandbox/fs-bridge.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { setRuntimeConfigSnapshot, writeConfigFile } from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import { encodePngRgb } from "../media/png-encode.js";
import {
  ensureCanonicalUserProfileForEmail,
  syncCanonicalGitHubIdentity,
} from "../state/user-profile-writes.js";
import { guestScopes } from "./github-publication-requester.test-support.js";
import {
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  commandResult,
  overrideCommands,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";

const mocks = githubPublicationTestMocks();
vi.mock("node:dns/promises", { spy: true });
// Mocked fetch normally skips DNS. Retain real guarded preflight with the isolated lookup.
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  const { lookup } = await import("node:dns/promises");
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({ ...params, lookupFn: lookup }),
  };
});

async function evidenceFixture(imported = false) {
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
  const evidence = {
    path: "proof.png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
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
  overrideCommands((argv) =>
    argv.includes(`repos/${f.publication.repository}`) && argv.includes(".id")
      ? commandResult("12345")
      : undefined,
  );
  if (imported) {
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 101, login: "contributor" },
      authenticationAlias: { kind: "email", email: "publication-guest@example.test" },
    });
    const repo = {
      id: 12345,
      full_name: f.publication.repository,
      private: false,
      archived: false,
      owner: { type: "User" },
      permissions: { push: true },
    };
    const number = Number(new URL(f.publication.url).pathname.split("/").at(-1));
    const base = {
      repository: repo.full_name,
      repositoryId: repo.id,
      branch: "main",
      commit: "b".repeat(40),
    };
    const head = { ...base, branch: f.publication.branch, commit: f.publication.headCommit };
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    await upsertSessionEntryCore(scope, {
      worktree: {
        ...loadSessionEntryReadOnly(scope)!.worktree!,
        githubPullRequest: {
          url: f.publication.url,
          host: "github.com",
          number,
          base,
          head,
          preparedHeadCommit: head.commit,
        },
      },
    });
    Object.assign(f.state, {
      number,
      user: { id: 101, login: "contributor" },
      maintainer_can_modify: false,
      base: { repo, ref: base.branch, sha: base.commit },
      head: { repo, ref: head.branch, sha: head.commit },
    });
    overrideCommands((argv) => {
      if (argv.includes("GET") && argv.at(-1) === `repos/${repo.full_name}`) {
        return commandResult(JSON.stringify(repo));
      }
      if (
        argv.includes("GET") &&
        argv.at(-1) === `repos/${repo.full_name}/branches/${encodeURIComponent(head.branch)}`
      ) {
        const branch = { name: head.branch, commit: { sha: head.commit }, protected: false };
        return commandResult(JSON.stringify(branch));
      }
      return undefined;
    });
  }
  let beforeLookup: (() => Promise<void>) | undefined;
  function lookup(_hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
  function lookup(_hostname: string, options?: LookupOneOptions | number): Promise<LookupAddress>;
  async function lookup(_hostname: string, options?: LookupOptions | number) {
    const pending = beforeLookup;
    beforeLookup = undefined;
    await pending?.();
    const address = { address: "93.184.216.34", family: 4 };
    return typeof options === "object" && options.all ? [address] : address;
  }
  vi.mocked(dnsLookup).mockImplementation(lookup);
  const url = "https://github.com/user-attachments/assets/10000000-0000-4000-8000-000000000001";
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ url }), { status: 201 }),
  );
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const upload = (input: Record<string, unknown> = {}, client?: typeof f.guestSource.client) =>
    f.invoke(
      "guest",
      {
        action: "upload_evidence",
        ...(imported ? { expectedHeadCommit: f.publication.headCommit } : f.expected),
        evidence,
        ...input,
      },
      SESSION_KEY,
      { client, sandbox },
    );
  return {
    ...f,
    sandbox,
    bytes,
    evidence,
    url,
    fetch,
    upload,
    config,
    async deselectPublisher() {
      const next = await updateGitHubToolIdentityConfig({
        scope: "system",
        agentId: "main",
        expectedIdentity: config.tools.github,
      });
      setRuntimeConfigSnapshot(next);
    },
    onLookup(callback: () => Promise<void>) {
      beforeLookup = callback;
    },
  };
}

describe("workspace evidence through the guest tool and registered publication action", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it("uploads to an imported PR and invalidates its binding before a later transfer", async () => {
    const f = await evidenceFixture(true);
    const result = await f.upload();
    expect(result.details).toMatchObject({
      pullRequest: { url: f.publication.url },
      evidence: { status: "uploaded", url: f.url },
    });
    expect(result.details).not.toHaveProperty("publication");
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    f.onLookup(async () => {
      const worktree = loadSessionEntryReadOnly(scope)!.worktree!;
      await upsertSessionEntryCore(scope, {
        worktree: {
          ...worktree,
          githubPullRequest: { ...worktree.githubPullRequest!, number: 999 },
        },
      });
    });
    await expect(f.upload()).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("uploads inspected guest workspace bytes and associates the reference only through metadata editing", async () => {
    const f = await evidenceFixture();
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
    const f = await evidenceFixture();
    await expect(
      f.invoke(
        "guest",
        { action: "upload_evidence", ...f.expected, evidence: f.evidence },
        SESSION_KEY,
        { raw: true },
      ),
    ).rejects.toThrow("not offered to sessions that run directly on the host");
    f.sandbox.sessionKey = "agent:main:foreign";
    await expect(f.upload()).rejects.toThrow("this conversation's active sandbox workspace");
    f.sandbox.sessionKey = SESSION_KEY;
    for (const filename of [
      "../foreign.png",
      "/workspace/proof.png",
      "https://example.test/proof.png",
      "unsafe\nname.png",
      "proof.txt",
    ]) {
      await expect(f.upload({ evidence: { ...f.evidence, path: filename } })).rejects.toThrow();
    }
    await expect(f.upload({ evidence: { ...f.evidence, sha256: "f".repeat(64) } })).rejects.toThrow(
      "bytes changed",
    );
    await expect(
      f.upload({ evidence: { ...f.evidence, sizeBytes: f.bytes.length - 1 } }),
    ).rejects.toThrow();
    await expect(
      f.upload({ evidence: { ...f.evidence, sizeBytes: 10_000_001 } }),
    ).rejects.toThrow();
    await fs.writeFile(path.join(f.local!.cwd, "fake.png"), "<html>private content</html>");
    const fake = Buffer.from("<html>private content</html>");
    await expect(
      f.upload({
        evidence: {
          path: "fake.png",
          sha256: createHash("sha256").update(fake).digest("hex"),
          sizeBytes: fake.length,
        },
      }),
    ).rejects.toThrow("do not match");
    const foreign = path.join(path.dirname(f.local!.cwd), "foreign.png");
    await fs.writeFile(foreign, f.bytes);
    await fs.symlink(foreign, path.join(f.local!.cwd, "foreign.png"));
    const foreignUpload = f.upload({ evidence: { ...f.evidence, path: "foreign.png" } });
    await expect(foreignUpload).rejects.toThrow(
      "Evidence could not be read from this conversation's workspace; no upload was attempted.",
    );
    await expect(foreignUpload).rejects.not.toThrow(f.local!.cwd);
    await expect(foreignUpload).rejects.not.toThrow(path.dirname(f.local!.cwd));
    await expect(f.upload({ publishingSessionKey: "agent:main:foreign" })).rejects.toThrow();
    await expect(f.upload({ requestId: randomUUID() })).rejects.toThrow("publication changed");
    await expect(
      f.upload({ evidence: { ...f.evidence, repository: "foreign/repo" } }),
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not follow redirects or repeat an uncertain evidence write", async () => {
    const f = await evidenceFixture();
    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://foreign.example/upload" } }),
      new Response("not JSON", { status: 201 }),
      new Response(JSON.stringify({ url: "https://foreign.example/asset" }), { status: 201 }),
      new Response("x".repeat(16 * 1024 + 1), { status: 201 }),
    ]) {
      f.fetch.mockClear();
      f.fetch.mockResolvedValueOnce(response);
      expect((await f.upload()).details).toMatchObject({ evidence: { status: "unconfirmed" } });
      expect(f.fetch).toHaveBeenCalledOnce();
    }
    f.fetch.mockClear();
    f.fetch.mockRejectedValueOnce(new Error("response lost after write"));
    expect((await f.upload()).details).toMatchObject({ evidence: { status: "unconfirmed" } });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.writes).toEqual([]);
  });

  it("rechecks the real publisher selection after transport preparation before sending evidence", async () => {
    const f = await evidenceFixture();
    await writeConfigFile(f.config);
    let deselected = false;
    f.onLookup(async () => {
      await f.deselectPublisher();
      deselected = true;
    });
    await expect(f.upload()).rejects.toThrow("publisher changed");
    expect(deselected).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("warns about an uncertain write when publisher authority is lost after dispatch", async () => {
    const f = await evidenceFixture();
    await writeConfigFile(f.config);
    f.fetch.mockImplementationOnce(async () => {
      await f.deselectPublisher();
      return new Response(JSON.stringify({ url: f.url }), { status: 201 });
    });
    await expect(f.upload()).rejects.toThrow("GitHub may have created the attachment");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("denies evidence publication to an admitted shared-session participant who is not its creator", async () => {
    const f = await evidenceFixture();
    const participant = await ensureCanonicalUserProfileForEmail(
      "publication-evidence-peer@example.test",
    );
    const client = createOperatorWsClient({ connId: participant.id, scopes: [...guestScopes] });
    client.authenticatedUserProfile = {
      profileId: participant.id,
      displayName: null,
      avatarRevision: "fixture",
      hasAvatar: false,
      updatedAt: 1,
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
    const f = await evidenceFixture();
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
    await expect(f.upload()).rejects.toThrow("Your operator role changed");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("retains session authority across the actual workspace byte read", async () => {
    const f = await evidenceFixture();
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
    await expect(f.upload()).rejects.toThrow();
    expect(readSpy).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
