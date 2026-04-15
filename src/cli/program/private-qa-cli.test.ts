import { describe, expect, it } from "vitest";
import { loadPrivateQaCliModule } from "./private-qa-cli.js";

describe("private-qa-cli", () => {
  it("loads the private QA CLI facade through the local plugin-sdk entrypoint", async () => {
    const module = await loadPrivateQaCliModule();

    expect(module).toMatchObject({
      isQaLabCliAvailable: expect.any(Function),
      registerQaLabCli: expect.any(Function),
    });
  });
});
