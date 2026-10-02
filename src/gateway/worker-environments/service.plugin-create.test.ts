import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import type { GatewayRequestHandlerOptions as CoreHandler } from "../../plugin-sdk/core.js";
import type { GatewayRequestHandlerOptions as RuntimeHandler } from "../../plugin-sdk/gateway-runtime.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/plugin-test-contracts.js";
import { disposePluginRegistryInstances } from "../../plugins/runtime.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import * as support from "./service.test-support.js";

type ShippedCreateParameters = [
  profileId: string,
  idempotencyKey: string,
  machineClass?: string,
  executionMode?: "worker-turn" | "remote-exec",
  projectPath?: string,
  signal?: AbortSignal,
  os?: string,
  runSetupScript?: boolean,
];
type SdkService = NonNullable<RuntimeHandler["context"]["workerEnvironmentService"]>;
type CreatedEnvironment = Awaited<ReturnType<SdkService["create"]>>;

async function withRegisteredCreator(
  service: ReturnType<typeof support.createService>,
  args: ShippedCreateParameters,
  run: (invoke: () => Promise<CreatedEnvironment>) => Promise<void>,
) {
  const fixture = createPluginRegistryFixture();
  const gatewayContext = createGatewayRequestContext(
    makeContextParams({ workerEnvironmentService: service }),
  );
  const created: CreatedEnvironment[] = [];
  try {
    registerVirtualTestPlugin({
      ...fixture,
      id: "legacy-worker-create",
      name: "Legacy worker create",
      register(api) {
        api.registerGatewayMethod(
          "legacy-worker-create.create",
          async ({ context, respond }: RuntimeHandler) => {
            const environments = expectDefined(context.workerEnvironmentService, "SDK service");
            const result = await environments.create(...args);
            created.push(result);
            respond(true, result);
          },
        );
      },
    });
    const handler = expectDefined(
      fixture.registry.registry.gatewayHandlers["legacy-worker-create.create"],
      "registered plugin worker method",
    );
    await run(async () => {
      await handler({
        client: null,
        context: gatewayContext,
        isWebchatConnect: () => false,
        params: {},
        req: { type: "req", id: "plugin-worker-create", method: "legacy-worker-create.create" },
        respond: vi.fn(),
      });
      expect(created).toHaveLength(1);
      return expectDefined(created.shift(), "plugin-created environment");
    });
  } finally {
    await disposePluginRegistryInstances(fixture.registry.registry);
  }
}

describe("worker creation through the shipped plugin Gateway context", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("preserves positional creation and idempotency through a registered handler", async () => {
    expectTypeOf<Parameters<SdkService["create"]>>().toEqualTypeOf<ShippedCreateParameters>();
    expectTypeOf<
      Parameters<NonNullable<CoreHandler["context"]["workerEnvironmentService"]>["create"]>
    >().toEqualTypeOf<ShippedCreateParameters>();
    const provision = vi.fn(async () => ({ leaseId: "plugin-lease", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    await withRegisteredCreator(service, ["development", "plugin-create"], async (invoke) => {
      const first = await invoke();
      const replayed = await invoke();
      expect(replayed.environmentId).toBe(first.environmentId);
      expect(first).toMatchObject({ state: "ready", profileId: "development" });
      expect(provision).toHaveBeenCalledOnce();
      expect(support.testState.store.list()).toHaveLength(1);
    });
  });

  it("preserves all eight positions and joins caller cancellation before allocation", async () => {
    const projectPath = path.join(support.testState.root, "plugin-project");
    await fs.mkdir(projectPath);
    await requireGit(projectPath, ["init", "--quiet"]);
    await requireGit(projectPath, ["config", "user.name", "Plugin Test"]);
    await requireGit(projectPath, ["config", "user.email", "plugin@example.invalid"]);
    await fs.writeFile(path.join(projectPath, "input.txt"), "plugin project\n");
    await requireGit(projectPath, ["add", "."]);
    await requireGit(projectPath, ["commit", "--quiet", "-m", "fixture"]);
    type PrepareOptions = Parameters<NonNullable<WorkerProvider["prepareProvision"]>>[2];
    const entered = createDeferredCore<PrepareOptions>();
    const released = createDeferredCore();
    const allocate = vi.fn(async () => ({
      leaseId: "must-not-allocate",
      ssh: support.SSH_ENDPOINT,
    }));
    const prepareNodeEnrollment = vi.fn<
      NonNullable<support.WorkerEnvironmentServiceOptions["prepareNodeEnrollment"]>
    >(async () => ({
      mode: "resume",
      deviceId: "plugin-node",
      displayName: "Plugin worker",
      openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
      nodeBootstrap: support.NODE_BOOTSTRAP,
      waitForDeviceId: async () => "plugin-node",
    }));
    const closeNodeEnrollment = vi.fn();
    const service = support.createService(
      support.createProvider({
        requiresNodeEnrollment: true,
        supportsProjectPreparation: () => true,
        resolvePreparationTarget: () => ({ machineClass: "large", platform: "linux" }),
        prepareProvision: async (_profile, _operationId, options) => {
          entered.resolve(options);
          await released.promise;
          return allocate;
        },
      }),
      {
        projectNamespace: "plugin-proof",
        prepareNodeEnrollment,
        closeNodeEnrollment,
        prepareNodeArtifacts: async () => ({
          artifacts: {
            nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
            enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
            workerBundleHash: support.BUNDLE_HASH,
            workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
            openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
            protocolFeatures: [...support.BUNDLE_ARTIFACT.protocolFeatures],
          },
          assertCurrent: () => {},
        }),
      },
    );
    const caller = new AbortController();
    const stopReason = new Error("Plugin caller stopped creation");
    await withRegisteredCreator(
      service,
      [
        "development",
        "plugin-options",
        "large",
        "remote-exec",
        projectPath,
        caller.signal,
        "linux",
        false,
      ],
      async (invoke) => {
        const creation = invoke();
        const settled = creation.catch((error: unknown) => error);
        try {
          const options = expectDefined(
            await Promise.race([
              entered.promise,
              settled.then((outcome) => {
                throw outcome;
              }),
            ]),
            "provider preparation options",
          );
          expect(options).toMatchObject({
            profileId: "development",
            machineClass: "large",
            os: "linux",
          });
          const project = expectDefined(options.project, "provider project");
          expect(project).toMatchObject({
            root: projectPath,
            preparation: { purpose: "session" },
          });
          expect(support.testState.store.list()).toMatchObject([
            {
              profileId: "development",
              profileSnapshot: {
                machineClass: "large",
                executionMode: "remote-exec",
                os: "linux",
                project: { root: projectPath, preparation: { runSetupScript: false } },
              },
            },
          ]);
          caller.abort(stopReason);
          expect(project.signal.aborted).toBe(true);
        } finally {
          caller.abort(stopReason);
          released.resolve();
          await settled;
        }
        await expect(creation).rejects.toThrow("Plugin caller stopped creation");
        expect(allocate).not.toHaveBeenCalled();
        expect(prepareNodeEnrollment).not.toHaveBeenCalled();
        expect(closeNodeEnrollment).not.toHaveBeenCalled();
      },
    );
  });
});
