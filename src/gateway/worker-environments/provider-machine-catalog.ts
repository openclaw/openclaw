import { isDeepStrictEqual } from "node:util";
import type { SessionPlacementMachine } from "../../../packages/gateway-protocol/src/index.js";
import type {
  WorkerMachineOption,
  WorkerOperatingSystem,
  WorkerProfile,
} from "../../plugins/types.js";
import { notifyListeners } from "../../shared/listeners.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import {
  normalizeWorkerMachineOptions,
  normalizeWorkerOperatingSystems,
  requireWorkerProfile,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export function createWorkerMachineCatalog(
  options: Pick<WorkerProviderLifecycleOptions, "getConfig" | "resolveProvider" | "warn">,
) {
  type CatalogValues = {
    machines: readonly WorkerMachineOption[] | undefined;
    systems: readonly WorkerOperatingSystem[] | undefined;
  };
  type MachineCatalog = {
    providerId: string;
    settings: WorkerProfile;
    requests: Partial<Record<keyof CatalogValues, Promise<CatalogValues[keyof CatalogValues]>>>;
  } & Partial<CatalogValues>;
  const machineCatalogs = new Map<string, MachineCatalog>();
  const machineShapeNotifications = { onChanged: (_profileId: string) => {} };
  let machineShapeVersion = 0;

  const machineCatalogChanged = (profileId: string) => {
    machineShapeVersion += 1;
    notifyListeners([machineShapeNotifications.onChanged], profileId, () => {
      options.warn("Worker machine metadata change reporting failed");
    });
  };

  const machineCatalogFor = (profileId: string) => {
    const profile = options.getConfig().cloudWorkers?.profiles?.[profileId];
    if (!profile) {
      return undefined;
    }
    const settings = requireWorkerProfile(profile.settings ?? {});
    let catalog = machineCatalogs.get(profileId);
    if (
      !catalog ||
      catalog.providerId !== profile.provider ||
      !isDeepStrictEqual(catalog.settings, settings)
    ) {
      catalog = {
        providerId: profile.provider,
        settings: structuredClone(settings),
        requests: {},
      };
      machineCatalogs.set(profileId, catalog);
      machineCatalogChanged(profileId);
    }
    return catalog;
  };

  const listCatalog = async (profileId: string, section: keyof CatalogValues) => {
    const catalog = machineCatalogFor(profileId);
    const pending = catalog?.requests[section];
    if (!catalog || pending) {
      return pending;
    }
    const request = (async () => {
      const provider = options.resolveProvider(catalog.providerId);
      const choices =
        section === "machines"
          ? normalizeWorkerMachineOptions(await provider?.listMachineOptions?.(catalog.settings))
          : normalizeWorkerOperatingSystems(
              await provider?.listOperatingSystems?.(catalog.settings),
            );
      if (!isDeepStrictEqual(catalog[section], choices)) {
        catalog[section] = choices;
        machineCatalogChanged(profileId);
      }
      return choices;
    })();
    catalog.requests[section] = request;
    try {
      return await request;
    } finally {
      delete catalog.requests[section];
    }
  };
  const listMachineOptions = (profileId: string): Promise<CatalogValues["machines"]> =>
    listCatalog(profileId, "machines");
  const listOperatingSystems = (profileId: string): Promise<CatalogValues["systems"]> =>
    listCatalog(profileId, "systems");

  const loadMachineShape = async (profileId: string): Promise<void> => {
    const catalog = machineCatalogFor(profileId);
    if (!catalog) {
      return;
    }
    const results = await Promise.allSettled([
      catalog.machines === undefined ? listMachineOptions(profileId) : undefined,
      catalog.systems === undefined ? listOperatingSystems(profileId) : undefined,
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  };

  const readMachineShape = (
    record:
      | Pick<WorkerEnvironmentRecord, "profileSnapshot" | "profileId" | "providerId">
      | undefined,
  ): SessionPlacementMachine | undefined => {
    if (!record) {
      return undefined;
    }
    const snapshot = record.profileSnapshot;
    const machineClass =
      typeof snapshot.machineClass === "string" ? snapshot.machineClass : undefined;
    const requestedOs = typeof snapshot.os === "string" ? snapshot.os : undefined;
    const catalog = machineCatalogs.get(record.profileId);
    const os = requestedOs ?? catalog?.systems?.find((system) => system.default)?.id;
    const eligible = catalog?.machines?.filter(
      (option) =>
        (!os || !option.os || option.os === os) &&
        (machineClass ? option.id === machineClass : option.default),
    );
    // Until the OS catalog arrives, only an unambiguous machine option is known.
    const machine = os
      ? (eligible?.find((option) => option.os === os) ?? eligible?.find((option) => !option.os))
      : eligible?.length === 1
        ? eligible[0]
        : undefined;
    const resolvedClass = machineClass ?? machine?.id;
    const osLabel = catalog?.systems?.find((system) => system.id === os)?.label;
    const shape = {
      ...(resolvedClass ? { class: resolvedClass } : {}),
      ...(os ? { os } : {}),
      ...(osLabel ? { osLabel } : {}),
      ...(machine?.cpu !== undefined ? { cpu: machine.cpu } : {}),
      ...(machine?.memoryGb !== undefined ? { memoryGb: machine.memoryGb } : {}),
    };
    return Object.keys(shape).length ? shape : undefined;
  };

  return {
    readProviderDisplayId: (profileId: string) => {
      try {
        const catalog = machineCatalogFor(profileId);
        const displayId =
          catalog &&
          options.resolveProvider(catalog.providerId)?.resolveDisplayId?.(catalog.settings);
        return typeof displayId === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(displayId)
          ? displayId
          : undefined;
      } catch {
        // Cosmetic metadata must not hide profiles or leak settings in diagnostics.
        return undefined;
      }
    },
    listMachineOptions,
    listOperatingSystems,
    readMachineShape,
    warmMachineShape: (profileId: string) => {
      void loadMachineShape(profileId).catch(() =>
        options.warn(`Worker machine catalog warmup failed for profile ${profileId}`),
      );
    },
    machineShapeNotifications,
    machineShapeVersion: () => machineShapeVersion,
  };
}
