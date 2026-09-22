import { isDeepStrictEqual } from "node:util";
import type { SessionPlacementMachine } from "../../../packages/gateway-protocol/src/index.js";
import type {
  WorkerMachineOption,
  WorkerOperatingSystem,
  WorkerProfile,
} from "../../plugins/types.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import {
  normalizeWorkerMachineOptions,
  normalizeWorkerOperatingSystems,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export function createWorkerMachineCatalog(
  options: Pick<WorkerProviderLifecycleOptions, "getConfig" | "resolveProvider" | "warn"> & {
    requireWorkerProfile: (value: unknown) => WorkerProfile;
  },
) {
  const { requireWorkerProfile } = options;
  type MachineCatalog = {
    providerId: string;
    settings: WorkerProfile;
    machines?: readonly WorkerMachineOption[];
    systems?: readonly WorkerOperatingSystem[];
    warmup?: Promise<void>;
  };
  const machineCatalogs = new Map<string, MachineCatalog>();
  const machineShapeListeners = new Set<(profileId: string) => void>();
  let machineShapeVersion = 0;

  const machineCatalogChanged = (profileId: string, catalog: MachineCatalog) => {
    if (machineCatalogs.get(profileId) === catalog) {
      machineShapeVersion += 1;
      for (const listener of machineShapeListeners) {
        try {
          listener(profileId);
        } catch {
          options.warn("Worker machine metadata change reporting failed");
        }
      }
    }
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
      catalog = { providerId: profile.provider, settings: structuredClone(settings) };
      machineCatalogs.set(profileId, catalog);
      machineCatalogChanged(profileId, catalog);
    }
    return catalog;
  };

  const listMachineOptions = async (profileId: string) => {
    const catalog = machineCatalogFor(profileId);
    if (!catalog) {
      return undefined;
    }
    const provider = options.resolveProvider(catalog.providerId);
    const machines = normalizeWorkerMachineOptions(
      await provider?.listMachineOptions?.(catalog.settings),
    );
    if (!isDeepStrictEqual(catalog.machines, machines)) {
      catalog.machines = machines;
      machineCatalogChanged(profileId, catalog);
    }
    return machines;
  };

  const listOperatingSystems = async (profileId: string) => {
    const catalog = machineCatalogFor(profileId);
    if (!catalog) {
      return undefined;
    }
    const provider = options.resolveProvider(catalog.providerId);
    const systems = normalizeWorkerOperatingSystems(
      await provider?.listOperatingSystems?.(catalog.settings),
    );
    if (!isDeepStrictEqual(catalog.systems, systems)) {
      catalog.systems = systems;
      machineCatalogChanged(profileId, catalog);
    }
    return systems;
  };

  const loadMachineShape = async (profileId: string): Promise<void> => {
    const catalog = machineCatalogFor(profileId);
    if (!catalog || catalog.warmup) {
      return catalog?.warmup;
    }
    const warmup = Promise.allSettled([
      catalog.machines === undefined ? listMachineOptions(profileId) : undefined,
      catalog.systems === undefined ? listOperatingSystems(profileId) : undefined,
    ])
      .then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure) {
          throw failure.reason;
        }
      })
      .finally(() => {
        catalog.warmup = undefined;
      });
    catalog.warmup = warmup;
    return warmup;
  };

  const readMachineShape = (
    record: WorkerEnvironmentRecord,
  ): SessionPlacementMachine | undefined => {
    const snapshot = record.profileSnapshot;
    const machineClass =
      typeof snapshot.machineClass === "string" ? snapshot.machineClass : undefined;
    const requestedOs = typeof snapshot.os === "string" ? snapshot.os : undefined;
    const cached = machineCatalogs.get(record.profileId);
    // A renamed/reconfigured profile must not relabel an already allocated worker.
    const catalog =
      cached?.providerId === record.providerId &&
      isDeepStrictEqual(cached.settings, snapshot.settings)
        ? cached
        : undefined;
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
    listMachineOptions,
    listOperatingSystems,
    readMachineShape,
    warmMachineShape: (profileId: string) => {
      void loadMachineShape(profileId).catch(() =>
        options.warn(`Worker machine catalog warmup failed for profile ${profileId}`),
      );
    },
    subscribeMachineShapeChanged: (listener: (profileId: string) => void) => {
      machineShapeListeners.add(listener);
      return () => {
        machineShapeListeners.delete(listener);
      };
    },
    clearMachineShapeListeners: () => machineShapeListeners.clear(),
    machineShapeVersion: () => machineShapeVersion,
  };
}
