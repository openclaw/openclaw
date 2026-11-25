import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
};

it("keeps the Bun action's staging helper and pin in its trusted sparse checkout", () => {
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
  ) as { jobs: { validate_selected_ref: { steps: Step[] } } };
  const steps = workflow.jobs.validate_selected_ref.steps;
  const requiredStep = (name: string) => {
    const step = steps.find((entry) => entry.name === name);
    if (!step) {
      throw new Error(`Missing release workflow step: ${name}`);
    }
    return step;
  };
  const checkout = requiredStep("Checkout workflow repository for Bun");
  const setup = requiredStep("Setup Bun test runtime");
  const identity = requiredStep("Resolve job workflow identity");
  const selectedSource = requiredStep("Materialize selected-source contract resolver");

  // The identity guard binds the default checkout to the called workflow before
  // candidate source can replace files used to install the trusted runtime.
  expect(steps.indexOf(identity)).toBeLessThan(steps.indexOf(checkout));
  expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(setup));
  expect(steps.indexOf(setup)).toBeLessThan(steps.indexOf(selectedSource));
  expect(checkout.with?.repository).toBeUndefined();
  expect(checkout.with?.ref).toBeUndefined();
  expect(checkout.with?.path).toBeUndefined();
  expect(checkout.with?.["sparse-checkout-cone-mode"]).toBe(false);
  expect(checkout.with?.["persist-credentials"]).toBe(false);
  expect(setup.uses).toBe("./.github/actions/setup-test-bun");

  const root = temporary.make("release-bun-sparse-");
  const files = [
    "package.json",
    ".github/actions/setup-test-bun/action.yml",
    "scripts/stage-openclaw-bun.sh",
    "scripts/lib/openclaw-bun.json",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(file));
  }
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/unselected.ts"), "candidate source must stay outside bootstrap\n");
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "runtime bootstrap fixture",
  ]);
  const sparsePaths = checkout.with?.["sparse-checkout"];
  expect(typeof sparsePaths).toBe("string");
  git(["sparse-checkout", "set", "--no-cone", "--stdin"], String(sparsePaths));

  expect(existsSync(join(root, "src/unselected.ts"))).toBe(false);
  for (const file of files) {
    expect(existsSync(join(root, file)), `Bun bootstrap is missing ${file}`).toBe(true);
    expect(readFileSync(join(root, file))).toEqual(readFileSync(file));
  }
});
