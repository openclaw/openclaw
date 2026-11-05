import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import {
  buildCloudWorkerPreparedPoolPatch,
  buildCloudWorkerRepositoryProfilePatch,
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

  it("changes only the chosen repository default", () => {
    const built = requirePatch(
      buildCloudWorkerRepositoryProfilePatch(config, "github.com/acme/app", "small"),
    );
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        ...config.cloudWorkers,
        projectProfiles: { "github.com/acme/app": "small", "github.com/acme/docs": "small" },
      },
    });
  });

  it.each([
    ["https://github.com/acme/%2e%2e/new", "small", "repository"],
    ["github.com/acme/new", "removed", "repositoryProfile"],
  ])(
    "refuses invalid repositories or unavailable profiles (%s, %s)",
    (repository, profileId, error) => {
      expect(buildCloudWorkerRepositoryProfilePatch(config, repository, profileId)).toEqual({
        error,
      });
    },
  );
});

describe("cloud worker prepared pool", () => {
  it.each(["3"])("sets the global cap to %s while preserving profiles and defaults", (value) => {
    const built = requirePatch(buildCloudWorkerPreparedPoolPatch(value));
    const next = applyMergePatch(config, built.patch);
    expect(next).toEqual({
      cloudWorkers: { ...config.cloudWorkers, preparedPool: { maxTotal: Number(value) } },
    });
    if (!isRecord(next)) {
      throw new Error("Expected merged config");
    }
    expect(readCloudWorkerPreparedPool(next)).toBe(String(Number(value)));
  });

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

  it.each(["9007199254740992"])("rejects invalid cap %s", (value) => {
    expect(buildCloudWorkerPreparedPoolPatch(value)).toEqual({ error: "preparedPool" });
  });
});
