import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import {
  buildCloudWorkerPreparedPoolPatch,
  buildCloudWorkerRepositoryDeletePatch,
  buildCloudWorkerRepositoryUpsertPatch,
  readCloudWorkerPreparedPool,
  readCloudWorkerRepositories,
  type CloudWorkerRepositoryPatch,
} from "./cloud-worker-repositories-config.ts";

const config = {
  cloudWorkers: {
    profiles: { production: { provider: "crabbox" }, small: { provider: "crabbox" } },
    projectProfiles: { "github.com/acme/app": "production", "github.com/acme/docs": "small" },
    preparedPool: { maxTotal: 8 },
  },
};

function requirePatch(result: CloudWorkerRepositoryPatch) {
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}

describe("cloud worker repository defaults", () => {
  it("reads configured defaults without discarding a missing profile", () => {
    expect(readCloudWorkerRepositories(null)).toEqual([]);
    expect(
      readCloudWorkerRepositories({
        cloudWorkers: { projectProfiles: { "github.com/acme/app": "removed" } },
      }),
    ).toEqual([{ repository: "github.com/acme/app", profileId: "removed" }]);
  });

  it.each([
    "github.com/ACME/New.git",
    "https://github.com/acme/new.git",
    "git@github.com:acme/new.git",
    "ssh://git@github.com:22/acme/new.git",
  ])("adds the normalized identity for %s without resending other mappings", (repository) => {
    const built = requirePatch(
      buildCloudWorkerRepositoryUpsertPatch(config, { repository, profileId: "small" }, null),
    );
    expect(built).toEqual({
      patch: { cloudWorkers: { projectProfiles: { "github.com/acme/new": "small" } } },
      replacePaths: [],
    });
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        ...config.cloudWorkers,
        projectProfiles: { ...config.cloudWorkers.projectProfiles, "github.com/acme/new": "small" },
      },
    });
  });

  it("changes the profile and moves the identity while preserving unrelated mappings", () => {
    const built = requirePatch(
      buildCloudWorkerRepositoryUpsertPatch(
        config,
        { repository: "github.com/acme/new", profileId: "small" },
        { repository: "github.com/acme/app", profileId: "production" },
      ),
    );
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        ...config.cloudWorkers,
        projectProfiles: { "github.com/acme/new": "small", "github.com/acme/docs": "small" },
      },
    });
    const retarget = requirePatch(
      buildCloudWorkerRepositoryUpsertPatch(
        config,
        { repository: "github.com/acme/app", profileId: "small" },
        { repository: "github.com/acme/app", profileId: "production" },
      ),
    );
    expect(retarget.patch).toEqual({
      cloudWorkers: { projectProfiles: { "github.com/acme/app": "small" } },
    });
  });

  it.each([
    ["", "small", null, "repository"],
    ["https://github.com/acme/../new", "small", null, "repository"],
    ["https://github.com/acme/%2e%2e/new", "small", null, "repository"],
    ["github.com/ACME/App.git", "small", null, "repositoryExists"],
    ["github.com/acme/docs", "small", "github.com/acme/app", "repositoryExists"],
    ["github.com/acme/new", "removed", null, "repositoryProfile"],
    ["github.com/acme/new", "", null, "repositoryProfile"],
    ["github.com/acme/new", "small", "github.com/acme/removed", "repositoryMissing"],
  ])("refuses invalid or stale mappings (%s, %s, %s)", (repository, profileId, original, error) => {
    expect(
      buildCloudWorkerRepositoryUpsertPatch(
        config,
        { repository: repository ?? "", profileId: profileId ?? "" },
        original ? { repository: original, profileId: "production" } : null,
      ),
    ).toEqual({ error });
  });

  it("rejects an edit after another update retargets the mapping", () => {
    const changed = {
      cloudWorkers: {
        ...config.cloudWorkers,
        projectProfiles: { ...config.cloudWorkers.projectProfiles, "github.com/acme/app": "small" },
      },
    };
    expect(
      buildCloudWorkerRepositoryDeletePatch(changed, {
        repository: "github.com/acme/app",
        profileId: "production",
      }),
    ).toEqual({ error: "repositoryMissing" });
    expect(
      buildCloudWorkerRepositoryUpsertPatch(
        changed,
        { repository: "github.com/acme/new", profileId: "production" },
        { repository: "github.com/acme/app", profileId: "production" },
      ),
    ).toEqual({ error: "repositoryMissing" });
  });

  it("deletes only the requested mapping and refuses a stale delete", () => {
    const built = requirePatch(
      buildCloudWorkerRepositoryDeletePatch(config, {
        repository: "github.com/acme/app",
        profileId: "production",
      }),
    );
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        ...config.cloudWorkers,
        projectProfiles: { "github.com/acme/docs": "small" },
      },
    });
    expect(
      buildCloudWorkerRepositoryDeletePatch(config, {
        repository: "github.com/acme/missing",
        profileId: "production",
      }),
    ).toEqual({
      error: "repositoryMissing",
    });
  });
});

describe("cloud worker prepared pool", () => {
  it.each(["0", "3", " 12 "])(
    "sets the global cap to %s while preserving profiles and defaults",
    (value) => {
      const built = requirePatch(buildCloudWorkerPreparedPoolPatch(value));
      const next = applyMergePatch(config, built.patch);
      expect(next).toEqual({
        cloudWorkers: { ...config.cloudWorkers, preparedPool: { maxTotal: Number(value) } },
      });
      if (!isRecord(next)) {
        throw new Error("Expected merged config");
      }
      expect(readCloudWorkerPreparedPool(next)).toBe(String(Number(value)));
    },
  );

  it("removes a configured cap when the field is emptied", () => {
    const built = requirePatch(buildCloudWorkerPreparedPoolPatch(" "));
    const next = applyMergePatch(config, built.patch);
    expect(next).toEqual({ cloudWorkers: { ...config.cloudWorkers, preparedPool: {} } });
    if (!isRecord(next)) {
      throw new Error("Expected merged config");
    }
    expect(readCloudWorkerPreparedPool(next)).toBe("");
    expect(readCloudWorkerPreparedPool(null)).toBe("");
  });

  it.each(["-1", "0.5", "NaN", "1e2", "9007199254740992"])("rejects invalid cap %s", (value) => {
    expect(buildCloudWorkerPreparedPoolPatch(value)).toEqual({ error: "preparedPool" });
  });
});
