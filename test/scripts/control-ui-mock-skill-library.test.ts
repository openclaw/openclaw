import { expect } from "vitest";
import { skillLibraryMockInitScript } from "../../scripts/control-ui-mock-skill-library.js";
import { createControlUiMockGatewayInitScript } from "../../ui/src/test-helpers/control-ui-e2e.js";
import {
  flushMockTimers,
  mockGatewayTest as it,
} from "../../ui/src/test-helpers/mock-gateway-page.test-support.js";
import { buildSkillLibraryMock } from "../../ui/src/test-helpers/skill-library-fixtures.js";

function installPreview(window: Window & typeof globalThis, execute: (script: string) => void) {
  window.history.replaceState(null, "", "/?skillLibrary=collaborator");
  window.structuredClone = structuredClone;
  execute(createControlUiMockGatewayInitScript({ methodResponses: { health: { ok: true } } }));
  execute(skillLibraryMockInitScript());
  return buildSkillLibraryMock()[0].entry;
}

it.for(["commands.list", "chat.metadata"])(
  "serves the selected pin through %s",
  async (method, { gatewayPage: page }) => {
    const selected = installPreview(page.window, page.execute);
    const socket = page.connect();
    await flushMockTimers();
    socket.send("catalog", method, { sessionKey: "agent:main:preview" });
    await flushMockTimers();
    expect(socket.frames.find((frame) => frame.id === "catalog")).toMatchObject({
      id: "catalog",
      ok: true,
      payload: {
        commands: [{ name: selected.name, source: "skill", scope: "both" }],
        ...(method === "chat.metadata" ? { models: [] } : {}),
      },
    });
  },
);

it("keeps concurrent library results on their requesting session and socket", async ({
  gatewayPage: page,
}) => {
  const { skillId } = installPreview(page.window, page.execute);
  const first = page.connect("ws://mock-gateway/first");
  const second = page.connect("ws://mock-gateway/second");
  await flushMockTimers();
  first.send("detach", "skills.library.activate", {
    sessionKey: "agent:main:detached",
    skillId,
    action: "detach",
  });
  await flushMockTimers();
  expect(first.frames.find((frame) => frame.id === "detach")).toMatchObject({
    ok: true,
    payload: { selections: [] },
  });
  first.send("pinned", "skills.library.list", { sessionKey: "agent:main:pinned" });
  second.send("detached", "skills.library.list", { sessionKey: "agent:main:detached" });
  first.send("health", "health", {});
  second.send("denied", "skills.library.read", { skillId });
  await flushMockTimers();
  const reply = (socket: typeof first, id: string) =>
    socket.frames.find((frame) => frame.id === id);
  expect([
    reply(first, "pinned"),
    reply(second, "detached"),
    reply(first, "health"),
    reply(second, "denied"),
  ]).toMatchObject([
    {
      ok: true,
      payload: { session: { sessionKey: "agent:main:pinned", selections: [{ skillId }] } },
    },
    { ok: true, payload: { session: { sessionKey: "agent:main:detached", selections: [] } } },
    { ok: true, payload: { ok: true } },
    { ok: false, error: { code: "INVALID_REQUEST", details: { code: "SKILL_LIBRARY_FORBIDDEN" } } },
  ]);
});
