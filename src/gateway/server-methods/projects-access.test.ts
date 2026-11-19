import { expect, test, vi } from "vitest";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import {
  initializeRepository,
  invokeProjectMethod as invoke,
  withProjectState,
} from "./projects.test-support.js";
test("restricted project discovery hides private repositories", async () => {
  await withProjectState(async (state) => {
    const repo = await initializeRepository(
      state.root,
      "restricted-private",
      "https://github.com/example/restricted-private.git",
    );
    await registerProjectRegistry({ path: repo });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ visibility: "private" }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await invoke("projects.list", {}, {}, ["operator.sessions.read"]);
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain("restricted-private");
  });
});
