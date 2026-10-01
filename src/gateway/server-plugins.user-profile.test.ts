import { expect, it, vi } from "vitest";
import * as pluginLoader from "../plugins/loader.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail, linkEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture } from "./control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { loadGatewayPlugins } from "./server-plugins.js";

it.each(["caller", "plugin", "gateway", "role"] as const)(
  "keeps registered profile preparation bound to its original targets and %s lifetime",
  async (closedOwner) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await createFixture("operator.read");
      const registry = createRequestGatewayMethodRegistry();
      fixture.context.getGatewayMethodRegistry = () => registry;
      const logger = { info() {}, warn() {}, error() {}, debug() {} };
      let runtime = createPluginRuntime();
      let retireGateway: (() => void) | undefined;
      const resolveGatewayContext = vi.fn(() => fixture.context);
      if (closedOwner === "gateway" || closedOwner === "role") {
        const loader = vi
          .spyOn(pluginLoader, "loadOpenClawPlugins")
          .mockImplementation((options = {}) => {
            runtime = createPluginRuntime(options.runtimeOptions);
            return createEmptyPluginRegistry();
          });
        try {
          const loaded = loadGatewayPlugins({
            cfg: fixture.cfg,
            autoEnabledReasons: {},
            baseMethods: [],
            loadIntent: "startup",
            pluginIds: ["visitor-access"],
            pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
              plugins: [{ id: "visitor-access" }],
            }),
            resolveGatewayContext,
          });
          retireGateway = loaded.retireGatewayRuntimeBindings;
        } finally {
          loader.mockRestore();
        }
      }
      const plugins = createPluginRegistry({
        runtime,
        logger,
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({ id: "visitor-access", origin: "bundled" });
      const untrustedRecord = createPluginRecord({ id: "untrusted-profile", origin: "workspace" });
      const api = plugins.createApi(record, { config: fixture.cfg });
      const untrustedApi = plugins.createApi(untrustedRecord, { config: fixture.cfg });
      plugins.registry.plugins.push(record, untrustedRecord);
      const withProfile = api.runtime.gateway.withUserProfileIdentity;
      const untrusted = untrustedApi.runtime.gateway.withUserProfileIdentity;
      if (!withProfile || !untrusted) {
        throw new Error("Expected profile identity preparation");
      }
      const scope = {
        context: fixture.context,
        client: fixture.client,
        isWebchatConnect: () => false,
        pluginId: "visitor-access",
        pluginOrigin: "bundled" as const,
      };
      const selected = "selected@example.test";
      const unselected = "unselected@example.test";
      const profile = ensureProfileForEmail(selected);
      const other = ensureProfileForEmail("other@example.test");
      linkEmail(unselected, profile.id);
      linkEmail("retained@example.test", profile.id);
      const params = { profileId: profile.id, emails: [selected] };
      try {
        const callback = vi.fn(async () => undefined);
        await expect(
          withPluginRuntimeGatewayRequestScope(scope, () => untrusted(params, callback)),
        ).rejects.toThrow();
        await expect(
          withPluginRuntimeGatewayRequestScope(scope, () =>
            withProfile({ ...params, emails: ["other@example.test"] }, callback),
          ),
        ).rejects.toThrow("user profile not found");
        expect(callback).not.toHaveBeenCalled();
        let retained: (() => void) | undefined;
        resolveGatewayContext.mockClear();
        const mutable = { ...params, emails: [...params.emails] };
        const preparing = withPluginRuntimeGatewayRequestScope(scope, () =>
          withProfile(mutable, async (assertCurrent) => {
            assertCurrent();
            linkEmail(unselected, other.id);
            assertCurrent();
            linkEmail(selected, other.id);
            expect(assertCurrent).toThrow("user profile not found");
            linkEmail(selected, profile.id);
            expect(assertCurrent).toThrow("user profile not found");
            return "checked";
          }),
        );
        mutable.profileId = other.id;
        mutable.emails.length = 0;
        await expect(preparing).resolves.toBe("checked");
        if (retireGateway) {
          expect(resolveGatewayContext).toHaveBeenCalled();
        }
        await withPluginRuntimeGatewayRequestScope(scope, () =>
          withProfile(params, async (assertCurrent) => {
            assertCurrent();
            retained = assertCurrent;
          }),
        );
        expect(retained).toBeDefined();
        expect(retained).toThrow();

        const entered = createDeferredCore();
        const release = createDeferredCore();
        let applied = false;
        const pending = withPluginRuntimeGatewayRequestScope(scope, () =>
          withProfile(params, async (assertCurrent) => {
            entered.resolve();
            await release.promise;
            assertCurrent();
            applied = true;
          }),
        );
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Profile callback was not reached");
            }),
          ]);
          if (closedOwner === "caller") {
            fixture.access.abort(new Error("Synthetic caller grant retired"));
          } else if (closedOwner === "gateway") {
            retireGateway?.();
          } else if (closedOwner === "role") {
            await fixture.changeReader("role");
          } else {
            plugins.rollbackPluginGlobalSideEffects(record.id, record);
          }
          release.resolve();
          await expect(pending).rejects.toThrow();
          expect(applied).toBe(false);
        } finally {
          release.resolve();
          await pending.catch(() => undefined);
        }
      } finally {
        retireGateway?.();
        plugins.rollbackPluginGlobalSideEffects(record.id, record);
        plugins.rollbackPluginGlobalSideEffects(untrustedRecord.id, untrustedRecord);
        await fixture.close();
        await fixture.removeSessions();
      }
    });
  },
);
