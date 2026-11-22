import { action, createMemo, createOptimistic, createSignal, onSettled } from "solid-js";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  profilesByRole,
  readRoleCatalog,
  type RolePatch,
  type RolePatchError,
} from "./role-catalog.ts";
import { RolesWriter } from "./roles-writer.ts";

export type RoleProfile = UserProfile;

/** Gateway-backed reads and writes for the Roles page; the runtime config owner stays authoritative. */
export function useRoles() {
  const context = useApplication();
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const directorySource = profileDirectory(context.gateway);
  const directory = projectOwner(directorySource, (owner) => owner);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const writer = new RolesWriter(() => setRevision((value) => value + 1));
  let lifetime = Promise.withResolvers<void>();
  function retirePresentation() {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  }
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => writer.update({ busy: false, error: null, notice: null }),
    onSnapshot: ({ snapshot }) => {
      if (
        snapshot.phase === "connected" &&
        !canCallGatewayMethod(snapshot, "config.patch", "operator.admin")
      ) {
        retirePresentation();
      }
    },
    invalidateRequests: () => {
      retirePresentation();
      writer.update({ busy: false, error: null, notice: null });
    },
  });
  onSettled(() => {
    void context.runtimeConfig.ensureLoaded();
  });
  const state = () => {
    revision();
    return writer.state;
  };
  const presentationLifetime = createMemo(() => {
    revision();
    void gateway.snapshot;
    return lifetime;
  });
  const presentation = createMemo(() => {
    const retired = presentationLifetime().promise;
    const [saving, setSaving] = createOptimistic(false);
    return { retired, saving, setSaving };
  });
  const present = action(function* (
    current: ReturnType<typeof presentation>,
    pending: Promise<boolean>,
  ): Generator<Promise<boolean>, boolean, boolean> {
    if (current.retired === lifetime.promise) {
      current.setSaving(true);
    }
    return yield Promise.race([pending, current.retired.then(() => false)]);
  });
  const busy = () => presentation().saving() || state().busy;
  const canAdmin = () => canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin");
  const config = createMemo(() =>
    resolveEditableSnapshotConfig(runtime.read().state.configSnapshot),
  );
  const catalog = createMemo(() => readRoleCatalog(config()));
  const profiles = createMemo<readonly RoleProfile[]>(
    () => directory.read().result?.profiles.filter((profile) => !profile.mergedInto) ?? [],
  );
  const people = createMemo(() => profilesByRole(profiles()));
  const editable = () =>
    canAdmin() &&
    Boolean(runtime.read().state.configSnapshot?.hash) &&
    !runtime.read().state.configSaving &&
    !busy();

  async function run(task: (isCurrent: () => boolean) => Promise<boolean>) {
    const scope = gateway.capture();
    const runtimeConfig = context.runtimeConfig;
    if (!scope || !canAdmin() || busy()) {
      return false;
    }
    const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
    const current = presentation();
    const pending = task(isCurrent);
    await Promise.resolve();
    return present(current, pending);
  }

  return {
    state,
    busy,
    canAdmin,
    editable,
    loading: () => !runtime.read().state.configSnapshot && runtime.read().state.configLoading,
    loadError: () =>
      runtime.read().state.configSnapshot ? null : (runtime.read().state.lastError ?? null),
    catalog,
    profiles,
    people,
    peopleLoaded: () => Boolean(directory.read().result),
    clearMessages: () => writer.update({ error: null, notice: null }),
    reload: () => context.runtimeConfig.ensureLoaded(),
    patch(
      build: (base: Readonly<Record<string, unknown>>) => RolePatch | RolePatchError,
      note: string,
      success: string,
    ) {
      return run((isCurrent) =>
        writer.patch(context.runtimeConfig, isCurrent, {
          build,
          note,
          success,
          canDispatch: () =>
            isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
        }),
      );
    },
    assign(selected: readonly RoleProfile[], role: string) {
      const client = gateway.client;
      if (!client) {
        return Promise.resolve(false);
      }
      return run(async (isCurrent) => {
        const ok = await writer.assign(client, isCurrent, selected, role);
        void directorySource.load(true);
        return ok;
      });
    },
  };
}

export type RolesState = ReturnType<typeof useRoles>;
