import { describe, it, expect } from "vitest";
import { classifyDockerError, dockerErrorMessage } from "./docker-errors.js";

describe("classifyDockerError", () => {
  it("detects Docker not installed", () => {
    expect(classifyDockerError("command not found: docker")).toBe("not-installed");
  });

  it("detects Docker not installed (docker not found variant)", () => {
    expect(classifyDockerError("docker: not found")).toBe("not-installed");
  });

  it("detects daemon not running", () => {
    expect(classifyDockerError("Cannot connect to the Docker daemon")).toBe("daemon-not-running");
  });

  it("detects daemon not running (is docker daemon running)", () => {
    expect(classifyDockerError("Is the docker daemon running?")).toBe("daemon-not-running");
  });

  it("detects permission denied", () => {
    expect(classifyDockerError("permission denied while trying to connect")).toBe(
      "permission-denied",
    );
  });

  it("detects image not found", () => {
    expect(
      classifyDockerError("manifest for mongodb/mongodb-community-search:latest not found"),
    ).toBe("image-not-found");
  });

  it("detects image not found (no matching manifest)", () => {
    expect(classifyDockerError("no matching manifest for linux/amd64")).toBe("image-not-found");
  });

  it("detects port conflict", () => {
    expect(classifyDockerError("Bind for 0.0.0.0:27017 failed: port is already allocated")).toBe(
      "port-conflict",
    );
  });

  it("detects port conflict (address already in use)", () => {
    expect(classifyDockerError("address already in use")).toBe("port-conflict");
  });

  it("detects network conflict", () => {
    expect(classifyDockerError("network clawmongo-net was found but has incorrect label")).toBe(
      "network-conflict",
    );
  });

  it("detects volume conflict", () => {
    expect(classifyDockerError("volume mongod_data already exists")).toBe("volume-conflict");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyDockerError("some random error")).toBe("unknown");
  });
});

describe("dockerErrorMessage", () => {
  it("returns user-friendly message for not-installed", () => {
    expect(dockerErrorMessage("not-installed")).toContain("Docker");
    expect(dockerErrorMessage("not-installed")).toContain("install");
  });

  it("returns user-friendly message for daemon-not-running", () => {
    expect(dockerErrorMessage("daemon-not-running")).toContain("start");
  });

  it("returns user-friendly message for permission-denied", () => {
    expect(dockerErrorMessage("permission-denied")).toContain("permission");
  });

  it("returns user-friendly message for port-conflict", () => {
    expect(dockerErrorMessage("port-conflict")).toContain("port");
  });

  it("returns user-friendly message for image-not-found", () => {
    expect(dockerErrorMessage("image-not-found")).toContain("image");
  });

  it("returns user-friendly message for unknown", () => {
    expect(dockerErrorMessage("unknown")).toContain("Docker");
  });
});
