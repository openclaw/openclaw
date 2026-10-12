import { vi } from "vitest";
import * as persistedAuthProfiles from "../agents/auth-profiles/persisted.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export async function withPersistedAuthProfileStoreRead<T>(
  read: (
    agentDir: string | undefined,
    options: Parameters<typeof persistedAuthProfiles.loadPersistedAuthProfileStore>[1],
    original: () => AuthProfileStore | null,
  ) => AuthProfileStore | null,
  run: () => Promise<T>,
): Promise<T> {
  const { loadPersistedAuthProfileStore, loadPersistedSharedAuthProfileStore } =
    persistedAuthProfiles;
  const local = vi
    .spyOn(persistedAuthProfiles, "loadPersistedAuthProfileStore")
    .mockImplementation((agentDir, options) =>
      read(agentDir, options, () => loadPersistedAuthProfileStore(agentDir, options)),
    );
  const shared = vi
    .spyOn(persistedAuthProfiles, "loadPersistedSharedAuthProfileStore")
    .mockImplementation((env) =>
      read(undefined, undefined, () => loadPersistedSharedAuthProfileStore(env)),
    );
  try {
    return await run();
  } finally {
    shared.mockRestore();
    local.mockRestore();
  }
}

export function makePrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}
