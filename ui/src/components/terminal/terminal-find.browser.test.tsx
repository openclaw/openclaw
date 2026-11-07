import { expect, it } from "vitest";
import "../../styles/base.css";
import "./terminal-panel.css";
import { userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { TerminalFind } from "./terminal-find.tsx";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";

async function mount(columns = 32) {
  const host = document.body.appendChild(document.createElement("div"));
  host.style.cssText = "width: 500px; height: 100px";
  const sent: string[] = [];
  const controller = await createIsolatedGhosttyTerminal({
    parent: host,
    autoFit: false,
    readOnly: false,
    size: { columns, rows: 4 },
    onData: (data) => sent.push(new TextDecoder().decode(data)),
  });
  const panel = document.body.appendChild(document.createElement("openclaw-terminal-panel"));
  panel.style.cssText = "display: block; position: relative; width: 500px; height: 160px";
  const view = mountSolid(() => <TerminalFind tab={{ controller }} />, { container: panel });
  view.getByRole("button", { name: "Find in terminal" }).click();
  flush();
  const input = view.getByRole("searchbox", { name: "Find in terminal" }) as HTMLInputElement;
  await waitForSolid(() => expect(document.activeElement).toBe(input));
  const search = async (query: string) => {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    await waitForSolid(() => expect(input.value).toBe(query));
  };
  return {
    ...view,
    controller,
    input,
    sent,
    search,
    close() {
      view.unmount();
      controller.dispose();
      host.remove();
      panel.remove();
    },
  };
}

it("finds real retained Unicode output and wraps navigation without sending terminal input", async () => {
  const view = await mount();
  try {
    const terminal = view.controller.terminal;
    view.controller.write(new TextEncoder().encode("界🚀 anchor\r\nsecond anchor\r\n"));
    for (let row = 0; row < 12; row++) {
      view.controller.write(new TextEncoder().encode(`ordinary ${row}\r\n`));
    }
    await view.search("anchor");
    await waitForSolid(() => expect(view.getByRole("status").textContent).toBe("1 of 2"));
    await waitForSolid(() => expect(terminal.getViewportY()).toBeGreaterThan(0));
    expect(view.container.querySelector(".tp-find__preview")?.textContent).toBe("界🚀 anchor");
    expect(view.container.querySelector("mark")?.textContent).toBe("anchor");
    view.getByRole("button", { name: "Previous match" }).click();
    flush();
    expect(view.getByRole("status").textContent).toBe("2 of 2");
    expect(view.container.querySelector(".tp-find__preview")?.textContent).toBe("second anchor");
    view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flush();
    expect(view.getByRole("status").textContent).toBe("1 of 2");
    await view.search("ANCHOR");
    expect(view.getByRole("status").textContent).toBe("0 of 0");
    expect(view.container.querySelector("mark")).toBeNull();
    expect(terminal.getSelection()).toBe("");
    expect(view.sent).toEqual([]);
    terminal.input("x", true);
    expect(view.sent).toEqual(["x"]);
    view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(view.queryByRole("searchbox")).toBeNull();
    expect(view.getByRole("button", { name: "Find in terminal" })).toBeDefined();
  } finally {
    view.close();
  }
});

it("refreshes streamed output and rescans after resize while matching literal visual rows", async () => {
  const view = await mount();
  try {
    view.controller.write(new TextEncoder().encode("[literal]\r\n"));
    await view.search("[literal]");
    expect(view.getByRole("status").textContent).toBe("1 of 1");
    view.controller.write(new TextEncoder().encode("[literal]\r\n"));
    view.getByRole("button", { name: "Refresh terminal matches" }).click();
    flush();
    expect(view.getByRole("status").textContent).toBe("1 of 2");
    view.controller.resize({ columns: 40, rows: 5 });
    view.getByRole("button", { name: "Next match" }).click();
    flush();
    expect(view.getByRole("status").textContent).toBe("2 of 2");
    await view.search("[literal][literal]");
    expect(view.getByRole("status").textContent).toBe("0 of 0");
    expect(view.sent).toEqual([]);
  } finally {
    view.close();
  }
});

it("preserves printed graphemes and spaces on screen and in history", async () => {
  const view = await mount();
  try {
    view.controller.write(new TextEncoder().encode("cafe\u0301 👩‍💻 a  \r\n"));
    for (const query of ["cafe\u0301", "👩‍💻", "a  "]) {
      await view.search(query);
      expect(view.getByRole("status").textContent).toBe("1 of 1");
      expect(view.container.querySelector("mark")?.textContent).toBe(query);
    }
    await view.search("a   ");
    expect(view.getByRole("status").textContent).toBe("0 of 0");
    for (let row = 0; row < 12; row++) {
      view.controller.write(new TextEncoder().encode(`ordinary ${row}\r\n`));
    }
    for (const query of ["cafe\u0301", "👩‍💻", "a  "]) {
      await view.search(query);
      expect(view.getByRole("status").textContent).toBe("1 of 1");
      expect(view.container.querySelector("mark")?.textContent).toBe(query);
    }
    expect(view.sent).toEqual([]);
  } finally {
    view.close();
  }
});

it("lets keyboard users activate each Find button with Enter", async () => {
  const view = await mount();
  try {
    view.controller.write(new TextEncoder().encode("anchor\r\nanchor\r\nanchor\r\n"));
    await view.search("anchor");
    // Finish emulator autofocus before moving focus with the real browser driver.
    await userEvent.click(view.input);
    view.getByRole("button", { name: "Previous match" }).focus();
    await userEvent.keyboard("{Enter}");
    flush();
    expect(view.getByRole("status").textContent).toBe("3 of 3");
    view.getByRole("button", { name: "Next match" }).focus();
    await userEvent.keyboard("{Enter}");
    flush();
    expect(view.getByRole("status").textContent).toBe("1 of 3");
    view.controller.write(new TextEncoder().encode("anchor\r\n"));
    view.getByRole("button", { name: "Refresh terminal matches" }).focus();
    await userEvent.keyboard("{Enter}");
    flush();
    expect(view.getByRole("status").textContent).toBe("1 of 4");
    view.getByRole("button", { name: "Close terminal find" }).focus();
    await userEvent.keyboard("{Enter}");
    flush();
    expect(view.queryByRole("searchbox")).toBeNull();
    expect(view.sent).toEqual([]);
  } finally {
    view.close();
  }
});

it("keeps the selected glyphs visible through navigation, reopening and resize", async () => {
  const view = await mount(120);
  try {
    view.controller.write(
      new TextEncoder().encode(`${"x".repeat(90)} needle\r\nneedle near start`),
    );
    await view.search("needle");
    const expectVisible = async () => {
      await waitForSolid(() => {
        const preview = view.container.querySelector<HTMLElement>(".tp-find__preview")!;
        const mark = preview.querySelector("mark")!;
        const box = preview.getBoundingClientRect();
        const selected = mark.getBoundingClientRect();
        expect(mark.textContent).toBe("needle");
        expect(selected.left).toBeGreaterThanOrEqual(box.left);
        expect(selected.right).toBeLessThanOrEqual(box.right);
        expect(getComputedStyle(preview).textOverflow).toBe("clip");
      });
    };
    await expectVisible();
    view.getByRole("button", { name: "Next match" }).click();
    flush();
    await expectVisible();
    view.getByRole("button", { name: "Previous match" }).click();
    flush();
    await expectVisible();
    view.getByRole("button", { name: "Close terminal find" }).click();
    flush();
    view.getByRole("button", { name: "Find in terminal" }).click();
    flush();
    await expectVisible();
    view.container.style.width = "320px";
    await expectVisible();
  } finally {
    view.close();
  }
});

it("advances from a surviving match when earlier visual rows disappear", async () => {
  const view = await mount();
  try {
    view.controller.write(
      new TextEncoder().encode("first anchor\r\nsecond anchor\r\nthird anchor"),
    );
    await view.search("anchor");
    view.getByRole("button", { name: "Next match" }).click();
    flush();
    expect(view.container.querySelector(".tp-find__preview")?.textContent).toBe("second anchor");
    view.controller.write(new TextEncoder().encode("\x1b[1;1H\x1b[M"));
    view.getByRole("button", { name: "Next match" }).click();
    flush();
    expect(view.getByRole("status").textContent).toBe("2 of 2");
    expect(view.container.querySelector(".tp-find__preview")?.textContent).toBe("third anchor");
  } finally {
    view.close();
  }
});
