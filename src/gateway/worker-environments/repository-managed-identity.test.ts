import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { resolveManagedGitHubProfileDir } from "../../agents/github-tool-identity.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as githubOAuthLifecycle from "../github-oauth-lifecycle.js";
import { repositoryDispatchCredentialReader } from "../repository-dispatch.js";
import { createNodeWorkerRepositoryPreparation } from "./node-worker-repository-preparation.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import { createRepositoryPolicySource } from "./repository-policy-node.test-support.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import * as support from "./service.test-support.js";

support.setupWorkerEnvironmentServiceSuite((_config, root) => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearGitHubCredentialVerificationCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

for (const kind of ["pat", "oauth"] as const) {
  it.each([
    "allowed",
    "denied",
    "missing-admission",
    "selected-during-refresh",
    "revoked-during-refresh",
    "revoked-after-seed",
    "caller-revoked-after-seed",
    "disposed-after-seed",
    "no-integration",
  ] as const)("admits managed " + kind + " repository checkout: %s", async (scenario) => {
    const root = support.testState.root;
    const origin = path.join(root, "origin");
    const { baseCommit } = await createRepositoryPolicySource(origin);
    const profileId = "ghp_88888888888888888888888888888888";
    const config = {
      agents: { entries: { main: { workspace: root } } },
      tools: { github: { profileId, ...(kind === "oauth" ? { kind } : {}) } },
      ...(scenario === "no-integration" ||
      scenario === "selected-during-refresh" ||
      scenario === "caller-revoked-after-seed"
        ? {}
        : { gateway: { repositoryIntegration: "repository-policy" } }),
    };
    const env = { OPENCLAW_STATE_DIR: root };
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: synthetic-managed-credential\n",
      { mode: 0o600 },
    );
    const profile = ensureProfileForEmail("managed-policy@example.invalid");
    support.testState.releaseTurnOwners.push((await prepareUserProfileCatalog()).release);
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "repository-policy",
      source: "synthetic-policy",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    });
    record.contracts = { repositoryIntegrations: ["repository"] };
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config });
    setActivePluginRegistry(builder.registry);
    setRuntimeConfigSnapshot(config);
    let policyCurrent = scenario !== "denied";
    let policyCalls = 0;
    const assertPolicyCurrent = () => {
      if (!policyCurrent) {
        throw new Error("Repository policy denied");
      }
    };
    const nativeRead = vi.fn(async () => {
      throw new Error("Managed credentials must remain with the native managed-profile owner");
    });
    api.registerRepositoryIntegration({
      version: 1,
      preparedCapacity: "image",
      resolveConnectionIdentity: () => undefined,
      async withIdentity(context, run) {
        policyCalls++;
        context.assertCurrent();
        assertPolicyCurrent();
        return await run({
          env: context.env,
          readNativeCredential: nativeRead,
          assertCurrent: assertPolicyCurrent,
        });
      },
    });
    const readNativeCredential = repositoryDispatchCredentialReader({
      client: {
        connId: "managed-policy-connection",
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "cli", mode: "cli", version: "test", platform: "test" },
          role: "operator",
          scopes: ["operator.write"],
        },
        internal: { authenticatedOperator: true },
      },
      agentId: "main",
      sessionId: "managed-session",
      sessionKey: "agent:main:managed",
      requestDigest: "managed-checkout",
      assertCurrent() {},
    });
    const verifyCredential = vi.fn(async () =>
      Response.json({ id: 202, login: "managed-fixture" }),
    );
    vi.stubGlobal("fetch", verifyCredential);
    const refresh = vi
      .spyOn(githubOAuthLifecycle, "requestCurrentGitHubOAuthRefresh")
      .mockImplementation(async () => {
        await Promise.resolve();
        if (scenario === "revoked-during-refresh") {
          policyCurrent = false;
        }
        if (scenario === "selected-during-refresh") {
          setRuntimeConfigSnapshot({ ...config, gateway: { repositoryIntegration: record.id } });
        }
      });
    if (scenario === "missing-admission" && kind === "pat") {
      await expect(
        prepareRepositoryWorkerProjectSource({
          namespace: "managed-policy",
          getConfig: () => config,
          assertCurrent() {},
          repository: { agentId: "main", url: "https://github.com/example/repository" },
        }),
      ).rejects.toThrow("current GitHub dispatch admission");
      expect(verifyCredential).not.toHaveBeenCalled();
    }
    const commands: string[] = [];
    const nodeHome = path.join(root, "node-home");
    await fs.mkdir(nodeHome, { recursive: true });
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "node-state"),
      env: { PATH: process.env.PATH, HOME: nodeHome },
    });
    let callerCurrent = true;
    const assertCallerCurrent = () => {
      if (!callerCurrent) {
        throw new Error("Worker caller retired");
      }
    };
    const checkout = async () => {
      const identity = await prepareRepositoryGitHubIdentity("main", assertCallerCurrent, {
        readNativeCredential: scenario === "missing-admission" ? undefined : readNativeCredential,
        repositoryUrl: "https://github.com/example/repository",
      });
      const repository = createNodeWorkerRepositoryPreparation(async (command) => {
        command.assertCurrent?.();
        commands.push(command.seed ? "seed" : command.argv.includes("clone") ? "clone" : "git");
        const result = await runtime.exec({
          gatewayNamespace: "managed-policy",
          environmentId: "worker",
          sessionId: "managed-session",
          generation: 1,
          argv: [...command.argv],
          input: command.input,
          seed: command.seed,
          resetWorkspace: command.resetWorkspace,
          timeoutMs: command.timeoutMs,
        });
        if (command.seed?.action === "apply") {
          if (scenario === "revoked-after-seed") {
            policyCurrent = false;
          }
          if (scenario === "caller-revoked-after-seed") {
            callerCurrent = false;
          }
          if (scenario === "disposed-after-seed") {
            await getPluginInstance(record)!.dispose();
          }
        }
        return result;
      }, identity.assertSelected);
      return await identity.start(() =>
        repository.prepareRepository({
          origin: pathToFileURL(origin).href,
          commit: baseCommit,
          gitToken: identity.token,
        }),
      );
    };
    if (scenario === "allowed" || scenario === "no-integration") {
      const result = await checkout();
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") {
        throw new Error("Managed checkout failed");
      }
      expect(
        await fs.readFile(path.join(result.result.remoteWorkspaceDir, "tracked.txt"), "utf8"),
      ).toBe("pinned source\n");
      expect(
        await fs.readFile(path.join(result.result.remoteWorkspaceDir, ".git", "config"), "utf8"),
      ).not.toContain("synthetic-managed-credential");
      expect(policyCalls).toBe(scenario === "no-integration" ? 0 : 1);
    } else {
      let rejected = false;
      try {
        await checkout();
      } catch {
        rejected = true;
      }
      expect({ rejected, policyCalls, commands }).toEqual({
        rejected: true,
        policyCalls:
          scenario === "missing-admission" ||
          scenario === "selected-during-refresh" ||
          scenario === "caller-revoked-after-seed"
            ? 0
            : 1,
        commands: scenario.endsWith("after-seed") ? ["seed"] : [],
      });
      if (scenario === "denied" || scenario === "missing-admission") {
        expect(refresh).not.toHaveBeenCalled();
      }
      if (!scenario.endsWith("after-seed")) {
        expect(verifyCredential).not.toHaveBeenCalled();
      }
    }
    expect(nativeRead).not.toHaveBeenCalled();
  });
}
