import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { SubmittedAppContext } from "./submitted-app-context.tsx";

it("shows saved App references with their icon and no draft removal controls", () => {
  const { container } = mountSolid(() => (
    <SubmittedAppContext
      message={{
        role: "user",
        content: "Describe this shell.",
        __openclaw: {
          appContext: [
            {
              title: "Helmet shell",
              icon: "https://example.test/shell.png",
              description: "Shared specimen facts",
            },
          ],
        },
      }}
    />
  ));
  expect(container.textContent).toContain("Helmet shell");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.test/shell.png",
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector(".mcp-app-context__item")?.getAttribute("title")).toBe(
    "Shared specimen facts",
  );
});
