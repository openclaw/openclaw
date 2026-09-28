import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import {
  hasMultipleSessionSharingIdentities,
  retainUserProfileCatalog,
} from "./user-profile-list.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail, linkEmail } from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("session sharing identity count", () => {
  it.each([false, true])("counts distinct people with resident catalog %s", (resident) => {
    const options = {
      path: join(tempDirs.make("openclaw-user-profile-list-"), "openclaw.sqlite"),
    };
    ensureGatewayOwnerProfile("Local Owner", options);
    const release = resident ? retainUserProfileCatalog(options) : undefined;
    expect(hasMultipleSessionSharingIdentities(options)).toBe(false);

    const first = ensureProfileForEmail("first@example.test", options);
    expect(hasMultipleSessionSharingIdentities(options)).toBe(false);

    ensureProfileForEmail("second@example.test", options);
    expect(hasMultipleSessionSharingIdentities(options)).toBe(true);

    linkEmail("second@example.test", first.id, options);
    expect(hasMultipleSessionSharingIdentities(options)).toBe(false);
    release?.();
  });
});
