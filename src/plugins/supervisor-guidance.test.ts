import { describe, expect, it } from "vitest";
import { parseSupervisorGuidance } from "./supervisor-guidance.js";

const guidance = {
  version: 1,
  name: "Docker Compose",
  runFrom: "Docker host",
  actions: { update: "docker compose pull && docker compose up -d gateway" },
};

describe("supervisor guidance display contract", () => {
  it("preserves shell punctuation, Unicode, and command bytes without interpretation", () => {
    const value = { ...guidance, actions: { restart: "管理 restart '$HOME' && echo 🚀" } };
    expect(parseSupervisorGuidance(value)).toEqual(value);
  });

  it("accepts multibyte strings exactly at each UTF-8 byte limit", () => {
    const value = {
      ...guidance,
      name: "é".repeat(64),
      runFrom: "é".repeat(128),
      actions: { update: "é".repeat(512) },
    };
    expect(parseSupervisorGuidance(value)).toEqual(value);
  });

  it.each([
    { ...guidance, version: 2 },
    { ...guidance, extra: true },
    { ...guidance, name: " padded " },
    { ...guidance, name: "x".repeat(129) },
    { ...guidance, name: "é".repeat(65) },
    { ...guidance, runFrom: "x".repeat(257) },
    { ...guidance, runFrom: "é".repeat(129) },
    { ...guidance, actions: {} },
    { ...guidance, actions: { execute: "anything" } },
    { ...guidance, actions: { update: "" } },
    { ...guidance, actions: { update: "x".repeat(1025) } },
    { ...guidance, actions: { update: "é".repeat(513) } },
    ...["\n", "\r", "\x1b", "\u202e", "\u2028", "\u2029", "\ud800"].map((character) => ({
      ...guidance,
      actions: { update: `echo${character}command` },
    })),
    {
      ...guidance,
      actions: Object.fromEntries(
        ["start", "stop", "restart", "install", "uninstall", "repair", "update"].map((action) => [
          action,
          "\\".repeat(1024),
        ]),
      ),
    },
  ])("rejects invalid or unsafe copy as a whole (%#)", (value) => {
    expect(parseSupervisorGuidance(value)).toBeUndefined();
  });
});
