import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { HeaderSearch } from "./header-search.tsx";
import { Popover } from "./popover.tsx";

it("focuses an autofocus search on first and retained popover openings", async () => {
  mountSolid(() => {
    const [query, setQuery] = createSignal("");
    const [expanded, setExpanded] = createSignal(true);
    return (
      <Popover id="project-search-focus" label="Projects" lazy>
        <HeaderSearch
          title="Projects"
          label="Search projects"
          open={expanded()}
          query={query()}
          onOpenChange={setExpanded}
          onQueryChange={setQuery}
          inputProps={{ autofocus: true }}
        />
      </Popover>
    );
  });

  const trigger = page.getByRole("button", { name: "Projects", exact: true });
  await trigger.click();
  const search = page.getByRole("searchbox");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("project");
  await expect.element(search).toHaveValue("project");

  await trigger.click();
  await expect
    .poll(() => document.getElementById("project-search-focus")?.matches(":popover-open"))
    .toBe(false);
  await trigger.click();
  await expect.element(search).toHaveFocus();
  await expect.element(search).toHaveValue("project");
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
  await userEvent.keyboard("projects");
  await expect.element(search).toHaveValue("projects");
});
