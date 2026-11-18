import { assert, describe, expect, it } from "vitest";
import {
  captureUpdateFinalizationDoctorOutput,
  UpdateFinalizationOutput,
} from "./update-finalization-output.js";

describe("finalization timeout output", () => {
  it("reassembles split UTF-8 and credentials before redacting and bounding excerpts", async () => {
    const output = new UpdateFinalizationOutput();
    await output.run(async () => {
      const capture = captureUpdateFinalizationDoctorOutput("pre-plugin")!;
      const bytes = Buffer.from(
        `completed café\npassword=${"synthetic".repeat(100)}\nactive database-check\n`,
      );
      for (const byte of bytes) {
        capture(Buffer.from([byte]), "stderr");
      }
      capture(Buffer.from("stdout only"), "stdout");
    });
    const snapshot = output.snapshot()!;
    expect(snapshot.stdout).toMatchObject({ excerpt: "stdout only", receivedBytes: 11 });
    expect(snapshot.stderr).toMatchObject({ excerpt: expect.stringContaining("completed café") });
    expect(JSON.stringify(snapshot)).toContain("active database-check");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic");
    expect(JSON.stringify(snapshot)).not.toContain("�");
    assert("excerpt" in snapshot.stderr);
    expect(Buffer.byteLength(snapshot.stderr.excerpt)).toBeLessThanOrEqual(256);
  });

  it.each([false, true])(
    "does not expose multiline private keys (complete=%s)",
    async (complete) => {
      const output = new UpdateFinalizationOutput();
      await output.run(async () => {
        const capture = captureUpdateFinalizationDoctorOutput("pre-plugin")!;
        capture(Buffer.from("-----BEGIN PRIVATE KEY-----\nfixture-private-material\n"), "stdout");
        if (complete) {
          capture(Buffer.from("-----END PRIVATE KEY-----\n"), "stdout");
        }
      });
      expect(JSON.stringify(output.snapshot())).not.toContain("fixture-private-material");
      if (!complete) {
        expect(output.snapshot()?.stdout).toMatchObject({ omitted: "incomplete-private-key" });
      }
    },
  );

  it("omits overflowing text while retaining byte and age facts independently per stream", async () => {
    const output = new UpdateFinalizationOutput();
    await output.run(async () => {
      const capture = captureUpdateFinalizationDoctorOutput("post-plugin")!;
      capture(Buffer.alloc(64 * 1024, "x"), "stdout");
      const boundary = output.snapshot()!.stdout;
      assert("excerpt" in boundary);
      expect(Buffer.byteLength(boundary.excerpt)).toBeLessThanOrEqual(256);
      capture(Buffer.from("password=fixture-private"), "stdout");
      capture(Buffer.from("active validation"), "stderr");
    });
    const snapshot = output.snapshot()!;
    expect(snapshot.stdout).toEqual({
      receivedBytes: 64 * 1024 + Buffer.byteLength("password=fixture-private"),
      lastOutputAgeMs: expect.any(Number),
      omitted: "capture-limit",
    });
    expect(snapshot.stderr).toMatchObject({ excerpt: "active validation" });
  });

  it("isolates commands and phases, including late output and silent commands", async () => {
    expect(captureUpdateFinalizationDoctorOutput("pre-plugin")).toBeUndefined();
    const output = new UpdateFinalizationOutput();
    expect(output.snapshot()).toBeUndefined();
    await output.run(async () => {
      const previous = captureUpdateFinalizationDoctorOutput("pre-plugin")!;
      previous(Buffer.from("old output"), "stderr");
      captureUpdateFinalizationDoctorOutput("post-plugin");
      previous(Buffer.from("late output"), "stderr");
      expect(output.snapshot()).toEqual({
        phase: "post-plugin",
        stdout: { receivedBytes: 0, lastOutputAgeMs: null, excerpt: "" },
        stderr: { receivedBytes: 0, lastOutputAgeMs: null, excerpt: "" },
      });
      output.close();
      previous(Buffer.from("closed output"), "stderr");
    });
    expect(output.snapshot()).toBeUndefined();
    expect(new UpdateFinalizationOutput().snapshot()).toBeUndefined();
  });
});
