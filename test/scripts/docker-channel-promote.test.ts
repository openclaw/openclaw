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

function createDockerMock(
  params: {
    candidateVersion?: string;
    currentVersion?: string;
    sourceImageConfigs?: Record<string, string>;
    wrongTargetDigest?: string;
    inspectAlias?: (ref: string) => void;
    sourceDigest?: () => string;
    onCreate?: (args: string[]) => void;
  } = {},
) {
  const targetDigests = new Map<string, string>();
  return vi.fn((_command: string, args: string[]) => {
    if (args[2] === "inspect") {
      const ref = args[3]!;
      if (args.at(-1)?.includes(".Image")) {
        if (!ref.includes("@")) {
          params.inspectAlias?.(ref);
        }
        const platform = args.at(-1)?.includes("linux/arm64") ? "linux/arm64" : "linux/amd64";
        if (ref.includes("@") && params.sourceImageConfigs?.[platform] !== undefined) {
          return params.sourceImageConfigs[platform];
        }
        return imageConfig(
          (ref.includes("@") ? params.candidateVersion : params.currentVersion) ?? "2026.6.33",
        );
      }
      if (params.wrongTargetDigest && ref.includes(":extended-stable")) {
        return JSON.stringify({ digest: params.wrongTargetDigest });
      }
      return JSON.stringify({
        digest: targetDigests.get(ref) ?? params.sourceDigest?.() ?? digest,
      });
    }
    const sourceDigest = args.at(-1)!.split("@")[1]!;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--tag") {
        targetDigests.set(args[index + 1]!, sourceDigest);
      }
    }
    params.onCreate?.(args);
    return "";
  });
}

function runPromotion(
  execFileSyncImpl: ReturnType<typeof createDockerMock>,
  options: Parameters<typeof promoteDockerChannel>[1] = {},
  params: Partial<Parameters<typeof promoteDockerChannel>[0]> = {},
) {
  return promoteDockerChannel(
    { version: "2026.6.33", images: images.slice(0, 1), ...params },
    { execFileSyncImpl, verifyAttestationsImpl: () => {}, ...options },
  );
}

function expectNoWrites(docker: ReturnType<typeof createDockerMock>) {
  expect(docker.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
}

type WorkflowStep = {
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

function expectTrustedCheckout(job: WorkflowJob) {
  expect(job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual(
    expect.objectContaining({ ref: "${{ github.sha }}", "persist-credentials": false }),
  );
}

describe("Docker channel promotion", () => {
  it("stops channel alias writes when authority is revoked between registries", () => {
    const writes: string[][] = [];
    let revoked = false;
    const docker = createDockerMock({
      candidateVersion: "2026.7.1",
      currentVersion: "2026.7.1",
      onCreate(args) {
        writes.push(args);
        revoked = writes.length === 3;
      },
    });

    expect(() =>
      runPromotion(
        docker,
        {
          revalidateAuthority: () => {
            if (revoked) {
              throw new Error("Publication authority revoked");
            }
          },
          log: () => {},
        },
        { version: "2026.7.1", images },
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
    const docker = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 3) {
        throw new Error("missing manifest");
      }
      return JSON.stringify({ digest });
    });

    expect(() => runPromotion(docker, {}, { images })).toThrow("missing manifest");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when a promoted alias does not match its version-specific source", () => {
    const docker = createDockerMock({ wrongTargetDigest: changedDigest });

    expect(() => runPromotion(docker, {}, { images })).toThrow(
      `resolved to ${changedDigest}, expected ${digest}`,
    );
  });

  it.each([false, true])("requires explicit rollback approval: %s", (allowRollback) => {
    const docker = createDockerMock({ currentVersion: "2026.6.34" });
    if (allowRollback) {
      runPromotion(docker, { allowRollback });
      expect(docker.mock.calls.some(([, args]) => args[2] === "create")).toBe(true);
    } else {
      expect(() => runPromotion(docker, {}, { imageTagSuffix: "-r20260820" })).toThrow(
        "Refusing to move ghcr.io/openclaw/openclaw:extended-stable backward from 2026.6.34 to 2026.6.33",
      );
      expect(docker.mock.calls[0]?.[1]).toContain("ghcr.io/openclaw/openclaw:2026.6.33-r20260820");
      expectNoWrites(docker);
    }
  });

  it("allows a first promotion for no such manifest in buffered stderr", () => {
    let created = false;
    const docker = createDockerMock({
      onCreate() {
        created = true;
      },
      inspectAlias() {
        if (!created) {
          throw Object.assign(new Error("docker inspect failed"), {
            stderr: Buffer.from("no such manifest"),
          });
        }
      },
    });

    runPromotion(docker);

    expect(created).toBe(true);
  });

  it.each([
    ["unrelated executable lookup", () => "docker credential helper: not found"],
    ["longer image token", (ref: string) => `mirror-${ref}: not found`],
  ] as const)("fails closed on %s while inspecting an existing alias", (_name, stderr) => {
    const docker = createDockerMock({
      inspectAlias(ref) {
        throw Object.assign(new Error("docker inspect failed"), { stderr: stderr(ref) });
      },
    });

    expect(() => runPromotion(docker)).toThrow("docker inspect failed");
    expectNoWrites(docker);
  });

  it("promotes the same digests whose attestations were verified", () => {
    let sourceDigest = digest;
    const docker = createDockerMock({ sourceDigest: () => sourceDigest });
    const verifiedRefs: string[] = [];

    runPromotion(docker, {
      verifyAttestationsImpl({ imageRefs }) {
        verifiedRefs.push(...imageRefs);
        sourceDigest = changedDigest;
      },
    });

    expect(verifiedRefs).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
    expect(
      docker.mock.calls.filter(([, args]) => args[2] === "create").map(([, args]) => args.at(-1)),
    ).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
  });

  it("rejects a custom-build source label at the requested-release comparison", () => {
    const candidateVersion = "custom-build";
    const docker = createDockerMock({ candidateVersion });

    expect(() => runPromotion(docker)).toThrow(
      `ghcr.io/openclaw/openclaw@${digest} reports version ${candidateVersion}, expected 2026.6.33`,
    );
    expectNoWrites(docker);
  });

  it.each([
    ["malformed JSON", "{", "linux/amd64"],
    ["second-platform missing label", "{}", "linux/arm64"],
  ])("rejects %s before writing aliases", (_name, raw, platform) => {
    const docker = createDockerMock({
      sourceImageConfigs: { [platform]: raw },
    });
    const attempt = vi.fn(() => runPromotion(docker));
    const sourceRef = `${images[0]}@${digest}`;

    expect(attempt).toThrow(
      raw === "{"
        ? `Could not parse the ${platform} image config for ${sourceRef}.`
        : `${sourceRef} does not have an org.opencontainers.image.version label for ${platform}.`,
    );
    if (raw === "{") {
      expect(attempt.mock.results[0]?.value).toHaveProperty("cause", expect.any(SyntaxError));
    } else {
      expect(attempt.mock.results[0]?.value).not.toHaveProperty("cause");
    }
    expect(docker.mock.calls.at(-1)?.[1]).toEqual([
      "buildx",
      "imagetools",
      "inspect",
      sourceRef,
      "--format",
      `{{json (index .Image "${platform}")}}`,
    ]);
    expectNoWrites(docker);
  });

  it("rejects a source whose platform version labels disagree", () => {
    const docker = createDockerMock({
      sourceImageConfigs: { "linux/arm64": imageConfig("2026.6.34") },
    });

    expect(() => runPromotion(docker)).toThrow(
      "inconsistent platform versions: linux/amd64=2026.6.33, linux/arm64=2026.6.34",
    );
    expectNoWrites(docker);
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
    const publicationLock = {
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    };

    expect(releaseWorkflow.concurrency).toBeUndefined();
    expect(publish.concurrency).toEqual(publicationLock);
    expect(publish.environment).toBeUndefined();
    expect(requireJob(releaseWorkflow, "approve").environment).toBe("docker-release");
    expect(publish.permissions).toEqual({
      actions: "read",
      attestations: "read",
      contents: "read",
      packages: "write",
    });

    expect(resolve.permissions).toEqual({ contents: "read" });
    expectTrustedCheckout(resolve);
    expect(approve).toMatchObject({ needs: "resolve", environment: "docker-release" });
    expect(approve.permissions).toEqual({});
    expect(promote.needs).toEqual(["resolve", "approve"]);
    expect(promote.permissions).toEqual({ contents: "read", packages: "write" });
    expect(promote.concurrency).toEqual(publicationLock);
    expectTrustedCheckout(promote);

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
