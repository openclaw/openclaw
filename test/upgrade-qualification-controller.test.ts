import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertQualificationImageIdentity,
  assertRootlessQualificationDaemon,
  runUpgradeQualificationController,
  upgradeQualificationRunManifestSchema,
} from "../scripts/lib/upgrade-qualification-controller.mts";

const runId = "00000000-0000-4000-8000-000000000001";

describe("release-only historical qualification controller", () => {
  it("requires the actual rootless security option, not an isolation attestation", () => {
    expect(
      assertRootlessQualificationDaemon(
        JSON.stringify({
          ID: "daemon",
          SecurityOptions: ["name=rootless", "name=seccomp,profile=builtin"],
        }),
      ),
    ).toBe("daemon");
    for (const SecurityOptions of [[], ["rootless"], ["name=rootless=false"]]) {
      expect(() =>
        assertRootlessQualificationDaemon(JSON.stringify({ ID: "daemon", SecurityOptions })),
      ).toThrow(/rootless Docker/);
    }
    for (const observation of ["bad-json", "{}", '{"ID":"daemon","SecurityOptions":null}']) {
      expect(() => assertRootlessQualificationDaemon(observation)).toThrow();
    }
  });

  it.each(["host", "context"])(
    "refuses a rootful daemon before machine creation with %s selection",
    async (selection) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "qualification-isolation-"));
      const originalPath = process.env.PATH;
      const originalHost = process.env.DOCKER_HOST;
      const originalContext = process.env.DOCKER_CONTEXT;
      try {
        const calls = path.join(root, "calls.jsonl");
        await fs.writeFile(
          path.join(root, "docker"),
          `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+"\\n");
if (args[0] === "context" && args[1] === "inspect") {
  console.log(JSON.stringify([{Endpoints:{docker:{Host:"unix:///fixture/context.sock"}}}]));
  process.exit(0);
}
if (args[2] !== "info") process.exit(9);
console.log(JSON.stringify({ID:"rootful",SecurityOptions:["name=seccomp,profile=builtin"]}));
`,
          { mode: 0o700 },
        );
        process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
        process.env.DOCKER_HOST = "unix:///fixture/rootful.sock";
        if (selection === "context") {
          process.env.DOCKER_CONTEXT = "selected-rootless";
        } else {
          delete process.env.DOCKER_CONTEXT;
        }
        const binding = { path: "/not-read", length: 1, sha256: "a".repeat(64) };
        const manifest = path.join(root, "manifest.json");
        await fs.writeFile(
          manifest,
          JSON.stringify({
            schemaVersion: 1,
            purpose: "fixture",
            image: `sha256:${"a".repeat(64)}`,
            architecture: "amd64",
            timeoutMs: 60_000,
            cells: [
              {
                id: "cell",
                runId,
                source: binding,
                target: binding,
                fixture: binding,
                inputs: [],
                apply: ["apply"],
                resume: ["resume"],
              },
            ],
          }),
        );
        await expect(
          runUpgradeQualificationController([
            "--run-manifest",
            manifest,
            "--output",
            path.join(root, "output"),
          ]),
        ).rejects.toThrow(/rootless Docker/);
        expect(
          (await fs.readFile(calls, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          ...(selection === "context" ? [["context", "inspect", "selected-rootless"]] : []),
          [
            "--host",
            selection === "context"
              ? "unix:///fixture/context.sock"
              : "unix:///fixture/rootful.sock",
            "info",
            "--format",
            "{{json .}}",
          ],
        ]);
      } finally {
        for (const [name, value] of [
          ["PATH", originalPath],
          ["DOCKER_HOST", originalHost],
          ["DOCKER_CONTEXT", originalContext],
        ]) {
          if (value === undefined) {
            delete process.env[name!];
          } else {
            process.env[name!] = value;
          }
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("binds a local content-addressed image and refuses a substituted machine identity", () => {
    const image = `sha256:${"a".repeat(64)}`;
    expect(assertQualificationImageIdentity(image, `${image}\n`)).toBe(image);
    expect(() => assertQualificationImageIdentity(image, `sha256:${"b".repeat(64)}`)).toThrow(
      /pinned local image/,
    );
    expect(() => assertQualificationImageIdentity(image, "debian:latest")).toThrow(/immutable/);
  });
  it("rejects an unpinned systemd image and commands encoded as shell strings", () => {
    expect(
      upgradeQualificationRunManifestSchema.safeParse({
        schemaVersion: 1,
        purpose: "fixture",
        image: "debian:latest",
        architecture: "amd64",
        timeoutMs: 60_000,
        cells: [],
      }).success,
    ).toBe(false);
  });

  it("rejects retired instrumented crash boundaries", () => {
    const binding = { path: "/fixture", length: 1, sha256: "a".repeat(64) };
    const manifest = {
      schemaVersion: 1,
      purpose: "historical-transition",
      image: `sha256:${"a".repeat(64)}`,
      architecture: "amd64",
      timeoutMs: 60_000,
      cells: [
        {
          id: "cell",
          runId,
          source: binding,
          target: binding,
          fixture: binding,
          inputs: [],
          apply: ["apply"],
          resume: ["resume"],
        },
      ],
    };
    expect(upgradeQualificationRunManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      upgradeQualificationRunManifestSchema.safeParse({
        ...manifest,
        cells: [{ ...manifest.cells[0], boundary: "gate-release-before" }],
      }).success,
    ).toBe(false);
  });
});
