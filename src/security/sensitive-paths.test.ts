import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSensitivePath, sensitivePathReason } from "./sensitive-paths.js";

const HOME = os.homedir();

describe("isSensitivePath", () => {
  it("blocks ~/.ssh paths", () => {
    expect(isSensitivePath(path.join(HOME, ".ssh", "id_rsa"))).toBe(true);
    expect(isSensitivePath(path.join(HOME, ".ssh", "config"))).toBe(true);
  });

  it("blocks ~/.aws paths", () => {
    expect(isSensitivePath(path.join(HOME, ".aws", "credentials"))).toBe(true);
  });

  it("blocks ~/.gnupg paths", () => {
    expect(isSensitivePath(path.join(HOME, ".gnupg", "private-keys-v1.d"))).toBe(true);
  });

  it("blocks ~/.openclaw/credentials paths", () => {
    expect(isSensitivePath(path.join(HOME, ".openclaw", "credentials", "token.json"))).toBe(true);
  });

  it("blocks /etc/shadow", () => {
    expect(isSensitivePath("/etc/shadow")).toBe(true);
  });

  it("blocks .env files by filename pattern", () => {
    expect(isSensitivePath("/some/project/.env")).toBe(true);
    expect(isSensitivePath("/some/project/.env.production")).toBe(true);
  });

  it("blocks .pem and .key files by filename pattern", () => {
    expect(isSensitivePath("/tmp/server.key")).toBe(true);
    expect(isSensitivePath("/tmp/cert.pem")).toBe(true);
  });

  it("allows normal workspace files", () => {
    expect(isSensitivePath("/tmp/workspace/src/index.ts")).toBe(false);
    expect(isSensitivePath(path.join(HOME, "projects", "app", "README.md"))).toBe(false);
  });

  it("allows non-sensitive home paths", () => {
    expect(isSensitivePath(path.join(HOME, "Documents", "notes.txt"))).toBe(false);
  });
});

describe("sensitivePathReason", () => {
  it("returns a reason for sensitive paths", () => {
    const reason = sensitivePathReason(path.join(HOME, ".ssh", "id_rsa"));
    expect(reason).toBeDefined();
    expect(reason).toContain("sensitive location");
  });

  it("returns undefined for safe paths", () => {
    expect(sensitivePathReason("/tmp/workspace/index.ts")).toBeUndefined();
  });
});
