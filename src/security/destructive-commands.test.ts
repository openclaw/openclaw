import { describe, expect, it } from "vitest";
import {
  ALL_DESTRUCTIVE_PATTERNS,
  KUBECTL_DESTRUCTIVE_PATTERNS,
  TERRAFORM_DESTRUCTIVE_PATTERNS,
  GCLOUD_DESTRUCTIVE_PATTERNS,
  FILESYSTEM_DESTRUCTIVE_PATTERNS,
  GIT_DESTRUCTIVE_PATTERNS,
} from "./destructive-commands.js";

describe("destructive-commands", () => {
  it("ALL_DESTRUCTIVE_PATTERNS is non-empty", () => {
    expect(ALL_DESTRUCTIVE_PATTERNS.length).toBeGreaterThan(0);
  });

  it("kubectl read-only commands are NOT in destructive patterns", () => {
    const safeOps = ["kubectl get pods", "kubectl describe node", "kubectl logs app-123"];
    for (const cmd of safeOps) {
      const matches = KUBECTL_DESTRUCTIVE_PATTERNS.some((p) =>
        cmd.startsWith(p.replace(" *", ""))
      );
      expect(matches).toBe(false);
    }
  });

  it("kubectl destructive commands ARE in patterns", () => {
    const destructive = ["kubectl delete pod foo", "kubectl drain node-1", "kubectl apply -f manifest.yaml"];
    for (const cmd of destructive) {
      const matches = KUBECTL_DESTRUCTIVE_PATTERNS.some((p) =>
        cmd.startsWith(p.split(" *")[0])
      );
      expect(matches).toBe(true);
    }
  });

  it("terraform safe commands are NOT in destructive patterns", () => {
    const safe = ["terraform plan", "terraform init", "terraform validate"];
    for (const cmd of safe) {
      const matches = TERRAFORM_DESTRUCTIVE_PATTERNS.some((p) =>
        cmd.startsWith(p.split(" *")[0])
      );
      expect(matches).toBe(false);
    }
  });

  it("terraform destructive commands ARE in patterns", () => {
    const destructive = ["terraform apply", "terraform destroy -auto-approve", "terraform taint resource"];
    for (const cmd of destructive) {
      const matches = TERRAFORM_DESTRUCTIVE_PATTERNS.some((p) =>
        cmd.startsWith(p.split(" *")[0])
      );
      expect(matches).toBe(true);
    }
  });

  it("rm is in filesystem destructive patterns", () => {
    expect(FILESYSTEM_DESTRUCTIVE_PATTERNS).toContain("rm *");
  });

  it("git push --force is in git destructive patterns", () => {
    const hasForce = GIT_DESTRUCTIVE_PATTERNS.some((p) => p.includes("force"));
    expect(hasForce).toBe(true);
  });

  it("all patterns are non-empty strings ending with *", () => {
    for (const pattern of ALL_DESTRUCTIVE_PATTERNS) {
      expect(typeof pattern).toBe("string");
      expect(pattern.length).toBeGreaterThan(0);
    }
  });

  it("no duplicate patterns", () => {
    const unique = new Set(ALL_DESTRUCTIVE_PATTERNS);
    expect(unique.size).toBe(ALL_DESTRUCTIVE_PATTERNS.length);
  });
});
