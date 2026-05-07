import { describe, expect, it } from "vitest";
import { selectRunnerLabels } from "../../scripts/ci-runner-labels.mjs";

describe("scripts/ci-runner-labels.mjs", () => {
  it("keeps Blacksmith labels by default", () => {
    expect(selectRunnerLabels()).toMatchObject({
      runner_4vcpu_ubuntu: "blacksmith-4vcpu-ubuntu-2404",
      runner_8vcpu_ubuntu: "blacksmith-8vcpu-ubuntu-2404",
      runner_16vcpu_ubuntu: "blacksmith-16vcpu-ubuntu-2404",
    });
  });

  it("falls back within backed-up Blacksmith runner families", () => {
    expect(
      selectRunnerLabels({
        queuedCountsByLabel: {
          "blacksmith-4vcpu-ubuntu-2404": 3,
          "blacksmith-8vcpu-ubuntu-2404": 0,
        },
        queueThreshold: 2,
      }),
    ).toMatchObject({
      runner_4vcpu_ubuntu: "ubuntu-24.04",
      runner_8vcpu_ubuntu: "ubuntu-24.04",
      runner_16vcpu_ubuntu: "ubuntu-24.04",
      runner_16vcpu_windows: "blacksmith-16vcpu-windows-2025",
    });
  });

  it("uses GitHub-hosted labels outside the canonical repo", () => {
    expect(
      selectRunnerLabels({
        canonicalRepository: false,
        queuedCountsByLabel: {
          "blacksmith-4vcpu-ubuntu-2404": 10,
        },
      }),
    ).toMatchObject({
      runner_4vcpu_ubuntu: "ubuntu-24.04",
    });
  });
});
