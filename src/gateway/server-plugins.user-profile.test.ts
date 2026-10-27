import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import * as pluginLoader from "../plugins/loader.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture } from "./control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { heldWork } from "./server-plugin-reload.fixture-tools.test-support.js";
import { loadGatewayPlugins } from "./server-plugins.js";

it.each(["caller", "plugin", "gateway", "role"] as const)(
  "keeps registered profile preparation bound to its original targets and %s lifetime",
  (closedOwner) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await createFixture("operator.read");
      const registry = createRequestGatewayMethodRegistry();
      fixture.context.getGatewayMethodRegistry = () => registry;
      let runtime = createPluginRuntime();
      let retireGateway: (() => void) | undefined;
      const resolveGatewayContext = vi.fn(() => fixture.context);
      if (closedOwner === "gateway" || closedOwner === "role") {
        const loader = vi
          .spyOn(pluginLoader, "loadOpenClawPluginsAsync")
          .mockImplementation(async (options = {}) => {
            runtime = createPluginRuntime(options.runtimeOptions);
            return createEmptyPluginRegistry();
          });
        try {
          const loaded = await loadGatewayPlugins({
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
      const plugins = createTestPluginRegistry(runtime);
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
      const scoped: typeof withProfile = (params, run) =>
        withPluginRuntimeGatewayRequestScope(scope, () => withProfile(params, run));
      const selected = "selected@example.test";
      const unselected = "unselected@example.test";
      const profile = ensureProfileForEmail(selected);
      const other = ensureProfileForEmail("other@example.test");
      linkEmail(unselected, profile.id);
      linkEmail("retained@example.test", profile.id);
      syncGitHubIdentity({
        identity: { accountId: 42, login: "selected-account" },
        authenticationAlias: { kind: "email", email: selected },
      });
      const params = { profileId: profile.id, emails: [selected], githubAccountIds: [42] };
      try {
        const callback = vi.fn(async () => undefined);
        await expect(
          withPluginRuntimeGatewayRequestScope(scope, () => untrusted(params, callback)),
        ).rejects.toThrow();
        for (const invalid of [{ emails: ["other@example.test"] }, { githubAccountIds: [84] }]) {
          await expect(scoped({ ...params, ...invalid }, callback)).rejects.toThrow(
            "user profile not found",
          );
        }
        expect(callback).not.toHaveBeenCalled();
        let retained: (() => void) | undefined;
        resolveGatewayContext.mockClear();
        const mutable = structuredClone(params);
        const preparing = scoped(mutable, async (assertCurrent) => {
          assertCurrent();
          linkEmail(unselected, other.id);
          assertCurrent();
          linkEmail(selected, other.id);
          expect(assertCurrent).toThrow("user profile not found");
          linkEmail(selected, profile.id);
          expect(assertCurrent).toThrow("user profile not found");
          return "checked";
        });
        mutable.profileId = other.id;
        mutable.emails.length = 0;
        mutable.githubAccountIds[0] = 84;
        await expect(preparing).resolves.toBe("checked");
        if (retireGateway) {
          expect(resolveGatewayContext).toHaveBeenCalled();
        }
        await scoped(params, async (assertCurrent) => {
          assertCurrent();
          retained = assertCurrent;
        });
        expect(retained).toThrow();

        const gate = heldWork();
        let applied = false;
        const pending = scoped(params, async (assertCurrent) => {
          await gate.run();
          assertCurrent();
          applied = true;
        });
        try {
          await awaitGateBeforeSettlement(
            gate.entered,
            pending,
            "Profile callback was not reached",
          );
          if (closedOwner === "caller") {
            fixture.access.abort(new Error("Synthetic caller grant retired"));
          } else if (closedOwner === "gateway") {
            retireGateway?.();
          } else if (closedOwner === "role") {
            await fixture.changeReader("role");
          } else {
            plugins.rollbackPluginGlobalSideEffects(record.id, record);
          }
          gate.release();
          await expect(pending).rejects.toThrow();
          expect(applied).toBe(false);
        } finally {
          gate.release();
          await pending.catch(() => undefined);
        }
      } finally {
        retireGateway?.();
        plugins.rollbackPluginGlobalSideEffects(record.id, record);
        plugins.rollbackPluginGlobalSideEffects(untrustedRecord.id, untrustedRecord);
        await fixture.close();
        await fixture.removeSessions();
      }
    }),
);
