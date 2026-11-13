import { expect, it } from "vitest";
import layoutStyles from "./layout.css?inline";

it("renders matching active, idle, and unknown presence in both sidebars", () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  try {
    const doc = frame.contentDocument!;
    const style = doc.createElement("style");
    style.textContent = layoutStyles;
    doc.head.append(style);
    doc.body.style.cssText = "--bg: #ffffff; --ok: #008800; --presence-idle: #cc8800";
    for (const [state, background, shadow] of [
      ["active", "rgb(0, 136, 0)", "none"],
      ["idle", "rgb(204, 136, 0)", "none"],
      ["unknown", "rgb(255, 255, 255)", "rgb(0, 136, 0) 0px 0px 0px 1.5px inset"],
    ]) {
      doc.body.innerHTML = `<span class="sidebar-session-group-presence sidebar-session-group-presence--${state}"></span>
        <div class="sidebar-online__person" data-presence-activity="${state}"><span class="sidebar-online__avatar"></span></div>`;
      const session = frame.contentWindow!.getComputedStyle(
        doc.querySelector(".sidebar-session-group-presence")!,
      );
      const user = frame.contentWindow!.getComputedStyle(
        doc.querySelector(".sidebar-online__avatar")!,
        "::after",
      );
      for (const dot of [session, user]) {
        expect(dot.width, state).toBe("6px");
        expect(dot.height, state).toBe("6px");
        expect(dot.boxSizing, state).toBe("content-box");
        expect(dot.right, state).toBe("-2px");
        expect(dot.bottom, state).toBe("-2px");
        expect(dot.borderTopWidth, state).toBe("2px");
        expect(dot.borderTopColor, state).toBe("rgb(255, 255, 255)");
        expect(dot.backgroundColor, state).toBe(background);
        expect(dot.boxShadow, state).toBe(shadow);
      }
    }
  } finally {
    frame.remove();
  }
});
