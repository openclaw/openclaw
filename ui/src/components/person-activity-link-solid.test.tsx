/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { PersonAvatarLink, PersonName } from "./person-activity-link-solid.tsx";
import { personActivityLink } from "./person-activity-link.ts";

describe("person activity links", () => {
  it("keeps one keyboard target beside a name and a target for a standalone avatar", () => {
    const navigate = vi.fn();
    const link = personActivityLink("ada", { basePath: "/ui", navigate }, "Ada");
    const view = mountSolid(() => (
      <>
        <PersonAvatarLink link={link}>
          <span role="img" aria-label="Ada" />
        </PersonAvatarLink>
        <PersonName label="Ada" link={link} class="chat-sender-name" />
        <PersonAvatarLink standalone link={link}>
          <span role="img" aria-label="Ada" />
        </PersonAvatarLink>
      </>
    ));
    const links = [...view.container.querySelectorAll("a")];
    expect(links).toHaveLength(3);
    expect(links.map((anchor) => anchor.tabIndex)).toEqual([-1, 0, 0]);
    expect(links[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(links[2]?.hasAttribute("aria-hidden")).toBe(false);
    for (const anchor of links) {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    }
    expect(navigate).toHaveBeenCalledTimes(3);
    expect(navigate).toHaveBeenLastCalledWith("ada", "Ada");

    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    links[1]?.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it("uses the current person's routing after an identity change and removes missing links", () => {
    const navigate = vi.fn();
    const [person, setPerson] = createSignal<string | null>("ada");
    const view = mountSolid(() => (
      <PersonAvatarLink standalone link={personActivityLink(person(), { basePath: "", navigate })}>
        <span role="img" aria-label="Owner" />
      </PersonAvatarLink>
    ));
    setPerson("bob");
    flush();
    view.container.querySelector("a")?.click();
    expect(navigate).toHaveBeenCalledWith("bob", undefined);
    setPerson(null);
    flush();
    expect(view.container.querySelector("a")).toBeNull();
    expect(view.container.querySelector('[aria-label="Owner"]')).not.toBeNull();
  });
});
