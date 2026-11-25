import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";
import { prepareUserProfileCatalog } from "./user-profile-list.js";
import { syncGitHubIdentity } from "./user-profile-writes.worker.js";

export function useProfileDatabase(prefix: string) {
  const releases: Array<() => void> = [];
  const options = { path: "" };
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      vi.restoreAllMocks();
      for (const release of releases.splice(0)) {
        release();
      }
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });
  beforeEach(() => {
    options.path = join(tempDirs.make(prefix), "openclaw.sqlite");
  });
  return {
    options,
    tempDirs,
    github: (
      accountId: number,
      login: string,
      fields: { alias?: string; email?: string; name?: string; initialName?: string } = {},
    ) =>
      syncGitHubIdentity(
        {
          identity: { accountId, login, name: fields.name },
          authenticationAlias:
            fields.email === undefined
              ? { kind: "github-login", login: fields.alias ?? login }
              : { kind: "email", email: fields.email },
          initialDisplayName: fields.initialName,
        },
        options,
      ),
    hydrate: async () => {
      releases.push((await prepareUserProfileCatalog(options)).release);
    },
  };
}

export function useProfileState(
  options: Parameters<typeof createOpenClawTestState>[0] = { layout: "state-only" },
  beforeCleanup = () => {},
) {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let release = () => {};
  beforeEach(async () => {
    state = undefined;
    state = await createOpenClawTestState(options);
  });
  afterEach(async () => {
    beforeCleanup();
    vi.restoreAllMocks();
    release();
    release = () => {};
    await state?.cleanup();
  });
  return {
    hydrate: async () => {
      release = (await prepareUserProfileCatalog()).release;
    },
    release: () => {
      release();
      release = () => {};
    },
  };
}

export const avatarPng = () =>
  Uint8Array.from(readFileSync(join(process.cwd(), "ui/public/favicon-32.png")));
export const avatarResponse = (bytes = avatarPng()) =>
  new Response(bytes.slice().buffer, { headers: { "content-type": "image/png" } });
