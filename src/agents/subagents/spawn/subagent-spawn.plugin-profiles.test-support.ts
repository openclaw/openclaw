import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { revokePluginRecord } from "../../../plugins/registry-lifecycle.js";
import { createOwnershipRecord } from "../../../plugins/registry-ownership.test-support.js";
import { createTestPluginRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createRequestNativeSubagentRuntime } from "../../plugin-native-subagent.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { holdQueuedSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  holdNativeCapacity,
  installNativeToolHook,
  nativeRequestSource,
} from "./subagent-spawn.plugin-native-rewrite.test-support.js";
import {
  createSpawnOperatorSource,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerNativePluginProfileCases(options: NativePluginSpawnTestOptions) {
  it("native profiles pin instructions and only narrow inherited tools; foreign profiles and schema rewrites fail before spawn", async () => {
    const source = createSpawnOperatorSource();
    const bound = await options.createBoundParent(source.authority);
    const { context, runtime } = await options.createBoundGateway(bound);
    const builder = createTestPluginRegistry();
    fs.mkdirSync(path.dirname(bound.storePath), { recursive: true });
    const root = fs.mkdtempSync(path.join(path.dirname(bound.storePath), "profiles-"));
    const instructions = "S5 pinned reviewer instructions. Never write files.";
    fs.writeFileSync(path.join(root, "reviewer.md"), instructions);
    const record = createOwnershipRecord("review-controller", {
      rootDir: root,
      contracts: { subagentProfiles: ["reviewer"] },
    });
    const api = builder.createApi(record, { config: bound.cfg });
    const schema = {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false,
    };
    expectDefined(
      api.agent.registerSubagentProfile,
      "registration",
    )({
      id: "reviewer",
      description: "Review only",
      instructionsFile: "reviewer.md",
      tools: { deny: ["read", "write", "exec"] },
      outputSchema: schema,
    });
    builder.registry.plugins.push(record);
    await holdNativeCapacity(bound, "profile-capacity");
    const children: string[] = [];
    const failures: unknown[] = [];
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, pluginRegistry: builder.registry, isWebchatConnect: () => false },
        async () => {
          const makeNative = (pluginId: string) =>
            createRequestNativeSubagentRuntime(nativeRequestSource(bound, source), {
              pluginId,
              assertCurrent: source.authority.assertCurrent,
            });
          const native = makeNative(record.id);
          const request = {
            requestId: "review",
            task: "Review",
            profile: "reviewer",
            context: "isolated" as const,
          };
          await expect(makeNative("foreign").spawn(request)).rejects.toThrow(
            "Unknown or undeclared",
          );
          await expect(native.spawn({ ...request, profile: "foreign/reviewer" })).rejects.toThrow(
            "Unknown or undeclared",
          );
          await expect(native.spawn({ ...request, outputSchema: {} })).rejects.toThrow(
            "cannot be replaced",
          );
          expect(subagentRuns.size).toBe(0);
          installNativeToolHook(record.id, async () => ({ params: { outputSchema: {} } }));
          await expect(native.spawn(request)).rejects.toThrow("must preserve");
          expect(subagentRuns.size).toBe(0);
          resetGlobalHookRunner();
          // A file replacement cannot change a profile already admitted by this registry.
          fs.writeFileSync(path.join(root, "reviewer.md"), "changed bytes");
          const child = await native.spawn(request);
          children.push(child.runId);
          expect(await native.spawn(request)).toEqual(child);
          const entry = expectDefined(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: child.childSessionKey }),
            "profile child",
          );
          expect(entry.inheritedToolAllow).toEqual(expect.arrayContaining(["read"]));
          expect(entry.inheritedToolAllow).not.toContain("exec");
          expect(entry.inheritedToolDeny).toEqual(
            expect.arrayContaining(["read", "write", "exec"]),
          );
          expect(entry.swarmOutputSchema).toEqual(schema);
          expect(subagentRuns.get(child.runId)).toMatchObject({
            subagentProfile: {
              pluginId: record.id,
              id: "reviewer",
              instructionsFile: "reviewer.md",
              instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
            },
            outputSchema: schema,
            queuedLaunch: { request: { extraSystemPrompt: expect.stringContaining(instructions) } },
          });
          await expect(native.spawn({ ...request, profile: undefined })).rejects.toThrow(
            "does not match",
          );
          const entered = createDeferred();
          const resume = createDeferred();
          installNativeToolHook(record.id, async () => {
            entered.resolve();
            await resume.promise;
          });
          const pending = native.spawn({ ...request, requestId: "revoked" });
          await entered.promise;
          revokePluginRecord(builder.registry, record);
          resume.resolve();
          await expect(pending).rejects.toThrow("no longer active");
          expect(subagentRuns.size).toBe(1);
        },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      resetGlobalHookRunner();
      bound.admission.close();
      bound.parent.cleanup();
      source.closeRequest();
      source.revoke();
      for (const id of children) {
        const queued = holdQueuedSwarmRun(id);
        await queued?.release();
      }
      releaseSwarmRun("profile-capacity");
      failures.push(...(await options.closeBoundGateway(bound, runtime, children[0])));
      const disposal = await disposePluginRegistryInstances(builder.registry);
      expect(disposal.failures).toEqual([]);
      fs.rmSync(root, { recursive: true, force: true });
      options.throwBoundFailures(failures);
    }
  });
}
