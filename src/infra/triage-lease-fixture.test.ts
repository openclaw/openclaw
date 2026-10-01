import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";

const hooks = vi.hoisted(() => ({ before: vi.fn(), after: vi.fn(), root: "" }));
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest")>()),
  beforeAll: hooks.before,
  afterAll: hooks.after,
}));
vi.mock("../../test/helpers/fixture-lifetime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../test/helpers/fixture-lifetime.js")>();
  return { createFixtureLifetime: () => actual.createFixtureLifetime(hooks.root) };
});

it("retains the coordinator and outer namespace claim when boundary cleanup is unverified", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "triage-retain-"));
  hooks.root = root;
  const { triageLeaseFixtureLifetime, useTriageLeaseDatabaseFixture } =
    await import("./triage-lease-fixture.test-support.js");
  const owner = createVitestResourceOwner(root);
  const failure = new Error("synthetic unjoined fixture group");
  try {
    useTriageLeaseDatabaseFixture();
    expect(hooks.before).toHaveBeenCalledOnce();
    expect(hooks.after).toHaveBeenCalledOnce();
    await hooks.before.mock.calls[0]![0]();
    const directory = fs
      .readdirSync(root)
      .find((name) => name.startsWith("triage-lease-coordinator-"));
    expect(directory).toBeDefined();
    const bootstrap = path.join(root, directory!, "bootstrap.mjs");
    expect(fs.existsSync(bootstrap)).toBe(true);
    await expect(
      triageLeaseFixtureLifetime.verifyCleanup(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(hooks.after.mock.calls[0]![0]()).rejects.toThrow(
      "Fixture cleanup unverified; retained",
    );
    expect(fs.existsSync(bootstrap)).toBe(true);
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
  } finally {
    // This control created no actors; its deliberately retained synthetic receipt is disposable.
    fs.rmSync(root, { recursive: true, force: true });
  }
});
