import { vi } from "vitest";

vi.mock("./agent-runner-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-run.js")>()),
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./route-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./route-reply.js")>()),
  routeReply: vi.fn(),
}));

vi.mock("./session-updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-updates.js")>()),
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
}));
