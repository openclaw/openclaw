import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionChoices, resolveResumeSession } from "./tui-session-picker.js";

describe("buildSessionChoices", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { preview: undefined, description: "5m ago" },
    { preview: "", description: "5m ago" },
    { preview: " \t\n ", description: "5m ago" },
    { preview: " Hello\nworld ", description: "5m ago · Hello world" },
  ])("keeps the update time with preview $preview", ({ preview, description }) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const [choice] = buildSessionChoices([
      {
        key: "agent:main:recent",
        updatedAt: 1_799_999_700_000,
        lastMessagePreview: preview,
      },
    ]);

    expect(choice?.description).toBe(description);
  });

  it("renders the Gateway display projection without reinterpreting quoted directives", () => {
    const [choice] = buildSessionChoices([
      {
        key: "agent:main:quoted-directive",
        lastMessagePreview: "Use `[[reply_to_current]]` literally.",
      },
    ]);

    expect(choice?.description).toBe("Use `[[reply_to_current]]` literally.");
  });
});

describe("resolveResumeSession", () => {
  it.each(["Café", "한국어"])("matches canonically equivalent titles for %s", (title) => {
    for (const [stored, query] of [
      [title.normalize("NFD"), title],
      [title, title.normalize("NFD")],
    ] as const) {
      const session = { key: "agent:main:original", displayName: stored };
      expect(resolveResumeSession([session], query)).toMatchObject({
        kind: "match",
        session: { value: session.key },
      });
    }
  });

  it("keeps equivalent titles ambiguous and exact session keys authoritative", () => {
    const sessions = [
      { key: "agent:main:first", displayName: "Café" },
      { key: "agent:main:second", displayName: "Café".normalize("NFD") },
    ];
    const result = resolveResumeSession(sessions, "Café");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.value)).toEqual(
        sessions.map((session) => session.key),
      );
    }
    expect(resolveResumeSession(sessions, sessions[1]!.key)).toMatchObject({
      kind: "match",
      session: { value: sessions[1]!.key },
    });
  });
});
