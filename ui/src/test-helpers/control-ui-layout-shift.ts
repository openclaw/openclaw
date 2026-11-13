import type { Page } from "playwright";

export function observeLayoutShifts(page: Page) {
  return page.evaluateHandle(() => {
    type Shift = PerformanceEntry & {
      hadRecentInput: boolean;
      value: number;
      sources: Array<{
        node: Node | null;
        previousRect: DOMRectReadOnly;
        currentRect: DOMRectReadOnly;
      }>;
    };
    const nodePath = (node: Node | null): string | null => {
      if (!node) {
        return null;
      }
      const path: string[] = [];
      let element = node instanceof Element ? node : node.parentElement;
      while (element) {
        const localName = element.localName;
        let part = localName;
        if (element.id) {
          path.unshift(`${part}#${CSS.escape(element.id)}`);
          break;
        }
        part += Array.from(element.classList, (name) => `.${CSS.escape(name)}`).join("");
        const siblings = element.parentElement
          ? Array.from(element.parentElement.children).filter(
              (sibling) => sibling.localName === localName,
            )
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
        }
        path.unshift(part);
        element = element.parentElement;
      }
      return path.join(" > ") + (node instanceof Text ? " > #text" : "");
    };
    const rect = ({ x, y, width, height }: DOMRectReadOnly) => ({ x, y, width, height });
    const entries: Array<{
      startTime: number;
      value: number;
      hadRecentInput: boolean;
      sources: Array<{
        node: string | null;
        previousRect: ReturnType<typeof rect>;
        currentRect: ReturnType<typeof rect>;
      }>;
    }> = [];
    const record = (records: PerformanceEntry[]) => {
      for (const entry of records) {
        // SAFETY: this observer requests only layout-shift entries.
        const shift = entry as Shift;
        entries.push({
          startTime: shift.startTime,
          value: shift.value,
          hadRecentInput: shift.hadRecentInput,
          sources: shift.sources.map((source) => ({
            node: nodePath(source.node),
            previousRect: rect(source.previousRect),
            currentRect: rect(source.currentRect),
          })),
        });
      }
    };
    const observer = new PerformanceObserver((list) => record(list.getEntries()));
    observer.observe({ type: "layout-shift", buffered: false });
    return {
      read: () => {
        record(observer.takeRecords());
        return {
          value: entries.reduce(
            (total, entry) => total + (entry.hadRecentInput ? 0 : entry.value),
            0,
          ),
          entries,
        };
      },
      stop: () => observer.disconnect(),
    };
  });
}
