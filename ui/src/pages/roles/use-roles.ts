import { action, createMemo, createOptimistic, createSignal, onSettled } from "solid-js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
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
  // Assigning yourself closes your own connection; a step left to finish runs on the next one.
  let resume: { scope: ReturnType<GatewayPageBinding["capture"]>; task: () => void } | null = null;
  function retirePresentation() {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  }
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => writer.update({ busy: false, error: null, notice: null }),
    onSnapshot: ({ snapshot }) => {
      if (snapshot.phase !== "connected") {
        return;
      }
      if (!canCallGatewayMethod(snapshot, "config.patch", "operator.admin")) {
        retirePresentation();
        resume = null;
        return;
      }
      if (resume && !(resume.scope && gateway.isCurrent(resume.scope))) {
        const { task } = resume;
        resume = null;
        queueMicrotask(task);
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
    // Roles never apply to the gateway owner, so it is not someone to show or assign here.
    () =>
      directory
        .read()
        .result?.profiles.filter(
          (profile) => !profile.mergedInto && profile.id !== GATEWAY_OWNER_PROFILE_ID,
        ) ?? [],
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
    /** A failed people read; without it the page would show everyone as having no role. */
    peopleError: () => {
      const { result, error } = directory.read();
      return !result && error ? formatUiError(error) : null;
    },
    reloadPeople: () => directorySource.load(true),
    /** The signed-in person's canonical profile; a session may be bound to a merged alias. */
    selfProfileId: () => {
      const id = gateway.snapshot?.selfUser?.id;
      const row = directory.read().result?.profiles.find((profile) => profile.id === id);
      return row?.mergedInto ?? id ?? null;
    },
    clearMessages: () => writer.update({ error: null, notice: null }),
    /** Runs `task` once the connection is replaced, e.g. after assigning yourself a role. */
    resumeAfterReconnect: (task: () => void) => {
      resume = { scope: gateway.capture(), task };
    },
    cancelResume: () => {
      resume = null;
    },
    /** Reads the current config again, e.g. after another administrator's change was refused. */
    reload: () => context.runtimeConfig.refresh(),
    patch(
      build: (base: Readonly<Record<string, unknown>>) => RolePatch | RolePatchError,
      note: string,
      success: string,
    ) {
      return run(async (isCurrent) => {
        const ok = await writer.patch(context.runtimeConfig, isCurrent, {
          build,
          note,
          success,
          canDispatch: () =>
            isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
        });
        // A default or definition change moves people between roles, so refresh who has each.
        // Awaited: a refresh joins any read in flight, so the next write waits for a fresh one.
        if (ok) {
          await directorySource.load(true);
        } else if (isCurrent()) {
          // A refused write usually means the config moved; read it so Reload shows the new version.
          await context.runtimeConfig.refresh({ background: true });
        }
        return ok;
      });
    },
    assign(selected: readonly RoleProfile[], role: string) {
      const client = gateway.client;
      if (!client) {
        return Promise.resolve(false);
      }
      return run(async (isCurrent) => {
        const ok = await writer.assign(client, isCurrent, selected, role);
        await directorySource.load(true);
        return ok;
      });
    },
  };
}

export type RolesState = ReturnType<typeof useRoles>;
