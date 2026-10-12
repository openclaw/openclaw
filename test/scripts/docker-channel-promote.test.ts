import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createDockerChannelPromotionPlan,
  promoteDockerChannel,
} from "../../scripts/docker-channel-promote.mjs";

const images = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
const digest = `sha256:${"1".repeat(64)}`;
const changedDigest = `sha256:${"2".repeat(64)}`;

function imageConfig(version: string): string {
  return JSON.stringify({
    config: { Labels: { "org.opencontainers.image.version": version } },
  });
}

function createDockerMock(params: {
  browserAvailable?: boolean;
  candidateVersion: string;
  currentVersion?: string;
  sourceImageConfigs?: Record<string, string>;
  wrongTargetDigest?: string;
}) {
  const targetDigests = new Map<string, string>();
  return vi.fn((_command: string, args: string[]) => {
    if (args[2] === "inspect") {
      const ref = args[3]!;
      if (params.browserAvailable === false && ref.includes("-browser")) {
        throw new Error(`${ref}: manifest unknown`);
      }
      if (args.at(-1)?.includes(".Image")) {
        const platform = args.at(-1)?.includes("linux/arm64") ? "linux/arm64" : "linux/amd64";
        if (ref.includes("@") && params.sourceImageConfigs?.[platform] !== undefined) {
          return params.sourceImageConfigs[platform];
        }
        return imageConfig(ref.includes("@") ? params.candidateVersion : params.currentVersion!);
      }
      if (params.wrongTargetDigest && ref.includes(":extended-stable")) {
        return JSON.stringify({ digest: params.wrongTargetDigest });
      }
      return JSON.stringify({ digest: targetDigests.get(ref) ?? digest });
    }
    const sourceDigest = args.at(-1)!.split("@")[1]!;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--tag") {
        targetDigests.set(args[index + 1]!, sourceDigest);
      }
    }
    return "";
  });
}

const skipAttestationVerification = () => {};

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | string>;
};

type WorkflowJob = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  environment?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function requireJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return job;
}

describe("Docker channel promotion", () => {
  it("stops channel alias writes when authority is revoked between registries", () => {
    const docker = createDockerMock({ candidateVersion: "2026.7.1", currentVersion: "2026.7.1" });
    const writes: string[][] = [];
    let revoked = false;
    const execFileSyncImpl = (command: string, args: string[]) => {
      const result = docker(command, args);
      if (args[2] === "create") {
        writes.push(args);
        if (writes.length === 3) {
          revoked = true;
        }
      }
      return result;
    };

    expect(() =>
      promoteDockerChannel(
        { version: "2026.7.1", images },
        {
          execFileSyncImpl,
          verifyAttestationsImpl: skipAttestationVerification,
          revalidateAuthority: () => {
            if (revoked) {
              throw new Error("Publication authority revoked");
            }
          },
          log: () => {},
        },
      ),
    ).toThrow("Publication authority revoked");
    expect(writes).toHaveLength(3);
  });

  it.each(["r20260820"])("rejects malformed rebuild suffix %s", (imageTagSuffix) => {
    expect(() =>
      createDockerChannelPromotionPlan({
        version: "2026.7.1",
        imageTagSuffix,
        images: images.slice(0, 1),
      }),
    ).toThrow("Invalid Docker image tag suffix");
  });

  it("fails without mutating when any version-specific source is missing", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 3) {
        throw new Error("missing manifest");
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow("missing manifest");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when a promoted alias does not match its version-specific source", () => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.33",
      wrongTargetDigest: changedDigest,
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow(`resolved to ${changedDigest}, expected ${digest}`);
  });

  it("refuses automatic channel rollback before writing aliases", () => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.34",
    });

    expect(() =>
      promoteDockerChannel(
        {
          version: "2026.6.33",
          imageTagSuffix: "-r20260820",
          images: images.slice(0, 1),
        },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow(
      "Refusing to move ghcr.io/openclaw/openclaw:extended-stable backward from 2026.6.34 to 2026.6.33",
    );
    expect(execFileSyncImpl.mock.calls[0]?.[1]).toContain(
      "ghcr.io/openclaw/openclaw:2026.6.33-r20260820",
    );
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it("allows an explicitly approved rollback", () => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.34",
    });

    promoteDockerChannel(
      { version: "2026.6.33", images: images.slice(0, 1) },
      {
        allowRollback: true,
        execFileSyncImpl,
        verifyAttestationsImpl: skipAttestationVerification,
      },
    );

    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(true);
  });

  it.each([
    [
      "no such manifest in buffered stderr",
      () =>
        Object.assign(new Error("docker inspect failed"), {
          stderr: Buffer.from("no such manifest"),
        }),
    ],
  ])("allows a first promotion for %s", (_label, createMissingError) => {
    let created = false;
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[2] === "create") {
        created = true;
        return "";
      }
      if (args.at(-1)?.includes(".Image")) {
        if (!args[3]!.includes("@") && !created) {
          throw createMissingError();
        }
        return imageConfig("2026.6.33");
      }
      return JSON.stringify({ digest });
    });

    promoteDockerChannel(
      { version: "2026.6.33", images: images.slice(0, 1) },
      { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
    );

    expect(created).toBe(true);
  });

  it.each([
    [
      "an unrelated executable lookup",
      Object.assign(new Error("docker inspect failed"), {
        stderr: "docker credential helper: not found",
      }),
    ],
  ])("fails closed on %s while inspecting an existing alias", (_label, inspectionError) => {
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.at(-1)?.includes(".Image") && !args[3]!.includes("@")) {
        throw inspectionError;
      }
      if (args.at(-1)?.includes(".Image")) {
        return imageConfig("2026.6.33");
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow(inspectionError.message);
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it("does not treat a longer image token as the inspected alias", () => {
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.at(-1)?.includes(".Image") && !args[3]!.includes("@")) {
        const error = new Error("docker inspect failed");
        Object.assign(error, { stderr: `mirror-${args[3]}: not found` });
        throw error;
      }
      return args.at(-1)?.includes(".Image")
        ? imageConfig("2026.6.33")
        : JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow("docker inspect failed");
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it("promotes the same digests whose attestations were verified", () => {
    let sourceDigest = digest;
    const targetDigests = new Map<string, string>();
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[2] === "create") {
        const promotedDigest = args.at(-1)!.split("@")[1]!;
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === "--tag") {
            targetDigests.set(args[index + 1]!, promotedDigest);
          }
        }
        return "";
      }
      if (args.at(-1)?.includes(".Image")) {
        return imageConfig("2026.6.33");
      }
      const ref = args[3]!;
      return JSON.stringify({ digest: targetDigests.get(ref) ?? sourceDigest });
    });
    const verifiedRefs: string[] = [];

    promoteDockerChannel(
      { version: "2026.6.33", images: images.slice(0, 1) },
      {
        execFileSyncImpl,
        verifyAttestationsImpl({ imageRefs }) {
          verifiedRefs.push(...imageRefs);
          sourceDigest = changedDigest;
        },
      },
    );

    expect(verifiedRefs).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
    expect(
      execFileSyncImpl.mock.calls
        .filter(([, args]) => args[2] === "create")
        .map(([, args]) => args.at(-1)),
    ).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
  });

  it.each(["custom-build"])(
    "rejects source label %s at the requested-release comparison",
    (candidateVersion) => {
      const execFileSyncImpl = createDockerMock({
        candidateVersion,
        currentVersion: "2026.6.33",
      });

      expect(() =>
        promoteDockerChannel(
          { version: "2026.6.33", images: images.slice(0, 1) },
          { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
        ),
      ).toThrow(
        `ghcr.io/openclaw/openclaw@${digest} reports version ${candidateVersion}, expected 2026.6.33`,
      );
      expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
    },
  );

  it.each([
    ["malformed JSON", "{", "linux/amd64"],
    ["second-platform missing label", "{}", "linux/arm64"],
  ])("rejects %s before writing aliases", (_name, raw, platform) => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.33",
      sourceImageConfigs: { [platform]: raw },
    });
    const promote = vi.fn(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    );
    const sourceRef = `${images[0]}@${digest}`;

    expect(promote).toThrow(
      raw === "{"
        ? `Could not parse the ${platform} image config for ${sourceRef}.`
        : `${sourceRef} does not have an org.opencontainers.image.version label for ${platform}.`,
    );
    if (raw === "{") {
      expect(promote.mock.results[0]?.value).toHaveProperty("cause", expect.any(SyntaxError));
    } else {
      expect(promote.mock.results[0]?.value).not.toHaveProperty("cause");
    }
    expect(execFileSyncImpl.mock.calls.at(-1)?.[1]).toEqual([
      "buildx",
      "imagetools",
      "inspect",
      sourceRef,
      "--format",
      `{{json (index .Image "${platform}")}}`,
    ]);
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it("rejects a source whose platform version labels disagree", () => {
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.at(-1)?.includes(".Image")) {
        const version = args.at(-1)?.includes("linux/arm64") ? "2026.6.34" : "2026.6.33";
        return imageConfig(version);
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow("inconsistent platform versions: linux/amd64=2026.6.33, linux/arm64=2026.6.34");
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it("rejects channels without moving aliases", () => {
    expect(() => createDockerChannelPromotionPlan({ version: "2026.7.2-beta.3", images })).toThrow(
      "no moving aliases",
    );
  });

  it("uses the digest-bound promotion path for releases and approved repairs", () => {
    const workflow = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/docker-release.yml");
    const publish = requireJob(releaseWorkflow, "publish");
    const resolve = requireJob(workflow, "resolve");
    const approve = requireJob(workflow, "approve");
    const promote = requireJob(workflow, "promote");

    expect(releaseWorkflow.concurrency).toBeUndefined();
    expect(publish.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(publish.environment).toBeUndefined();
    expect(requireJob(releaseWorkflow, "approve").environment).toBe("docker-release");
    expect(publish.permissions).toEqual({
      actions: "read",
      attestations: "read",
      contents: "read",
      packages: "write",
    });

    expect(resolve.permissions).toEqual({ contents: "read" });
    expect(resolve.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual(
      expect.objectContaining({ ref: "${{ github.sha }}", "persist-credentials": false }),
    );
    expect(approve.needs).toBe("resolve");
    expect(approve.environment).toBe("docker-release");
    expect(approve.permissions).toEqual({});
    expect(promote.needs).toEqual(["resolve", "approve"]);
    expect(promote.permissions).toEqual({ contents: "read", packages: "write" });
    expect(promote.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(promote.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual(
      expect.objectContaining({ ref: "${{ github.sha }}", "persist-credentials": false }),
    );

    const steps = promote.steps ?? [];
    const promotionIndex = steps.findIndex(
      (step) => step.name === "Promote and verify channel aliases",
    );
    expect(steps.some((step) => step.run?.includes("verify-docker-attestations.mjs"))).toBe(false);
    expect(promotionIndex).toBeGreaterThan(-1);
    expect(steps[promotionIndex]?.run).toContain("node scripts/docker-channel-promote.mjs");
    expect(steps[promotionIndex]?.run).toContain("--allow-rollback");

    const packageWriters = Object.entries(workflow.jobs ?? {}).filter(
      ([, job]) => job.permissions?.packages === "write",
    );
    expect(packageWriters.map(([name]) => name)).toEqual(["promote"]);
    expect(packageWriters[0]?.[1].needs).toContain("approve");
  });
});
