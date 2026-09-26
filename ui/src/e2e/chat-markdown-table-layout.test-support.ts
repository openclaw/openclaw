export function readResponsiveTableGeometry(element: HTMLElement) {
  const viewport = element.querySelector<HTMLElement>(".markdown-table__viewport")!;
  const table = element.querySelector("table")!;
  const cells = table.querySelectorAll("tbody tr:first-child td");
  const paragraph = element.parentElement!.querySelector("p")!;
  const pane = element.closest(".chat-thread")!;
  const action = element.querySelector("button")!;
  const rect = element.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const header = table.querySelector("th")!.getBoundingClientRect();
  const siblings = element.parentElement!.querySelectorAll<HTMLElement>(".markdown-table");
  const dense = siblings[3]!;
  const denseViewport = dense.querySelector<HTMLElement>(".markdown-table__viewport")!;
  return {
    compactWidths: [...siblings].slice(1, 3).map((node) => node.getBoundingClientRect().width),
    denseWidth: dense.getBoundingClientRect().width,
    denseOverflow: denseViewport.scrollWidth - denseViewport.clientWidth,
    controlHeight: action.getBoundingClientRect().height,
    visibleExpandLabel:
      element.querySelector(".markdown-table__expand > span")!.getClientRects().length > 0,
    controlsGap:
      table.getBoundingClientRect().top -
      element.querySelector(".markdown-table__actions")!.getBoundingClientRect().bottom,
    bottomGap: element.nextElementSibling!.getBoundingClientRect().top - rect.bottom,
    width: rect.width,
    prose: paragraph.getBoundingClientRect().width,
    withinPane: rect.left >= paneRect.left && rect.right <= paneRect.right,
    verticalOverflow: viewport.scrollHeight - viewport.clientHeight,
    columnWidths: [...cells].map((cell) => cell.getBoundingClientRect().width),
    topAligned: [...cells].every((cell) => getComputedStyle(cell).verticalAlign === "top"),
    headerPainted: table.contains(document.elementFromPoint(header.left + 4, header.top + 4)),
    actionAboveTable: action.getBoundingClientRect().bottom <= table.getBoundingClientRect().top,
  };
}
