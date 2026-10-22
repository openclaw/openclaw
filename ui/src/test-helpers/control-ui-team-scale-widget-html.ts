import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps/app-bridge";

export function dashboardPaintMarkerHtml(html: string): string {
  return html.replace(
    "</head>",
    "<style>html,body{background:transparent!important;color:CanvasText!important}:root{color-scheme:light dark}section{background:Canvas;border-color:GrayText}.chart i{background:rgb(239,18,205)}svg{color:rgb(239,18,205)}</style></head>",
  );
}

export function dashboardMcpAppHtml(stylesheetUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team dashboard</title>
<link rel="stylesheet" href="${stylesheetUrl}"></head><body>
<h2>Team metric 1</h2><p>Synthetic dashboard activity</p><main aria-label="Metric charts"></main>
<script>
const send = (message) => parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
addEventListener("message", ({ source, data }) => {
  if (source !== parent) return;
  if (data.id === 1 && data.result) send({ method: "ui/notifications/initialized" });
  if (data.method === "ui/resource-teardown") send({ id: data.id, result: {} });
});
send({ id: 1, method: "ui/initialize", params: {
  appInfo: { name: "Synthetic team dashboard", version: "1.0.0" }, appCapabilities: {},
  protocolVersion: ${JSON.stringify(LATEST_PROTOCOL_VERSION)}
} });
const charts = document.querySelector("main");
for (let index = 0; index < 4; index++) {
  const chart = document.createElement("section");
  const values = Array.from({ length: 12 }, (_, point) => 20 + (point * 17 + index * 23) % 75);
  chart.innerHTML = '<h3>Metric ' + (index + 1) + '</h3><svg role="img" aria-label="Synthetic chart ' +
    (index + 1) + '" viewBox="0 0 240 100"><polyline fill="none" stroke="currentColor" stroke-width="3" points="' +
    values.map((value, point) => (point * 20) + ',' + (100 - value)).join(' ') + '"/></svg>';
  charts.append(chart);
}
</script></body></html>`;
}

export function widgetHtml(index: number) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team metric ${index + 1}</title>
<style>:root{color-scheme:dark light;font-family:system-ui}body{margin:0;padding:20px}h2{font-size:18px}progress{width:100%}</style></head>
<body><h2>Team metric ${index + 1}</h2><p>Synthetic completed work: ${60 + index}%</p>
<progress value="${60 + index}" max="100"></progress><p>All fixture systems are available.</p></body></html>`;
}

export function dashboardWidgetHtml(fontUrl: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team metric 1</title>
<style>
@font-face{font-family:FixtureDashboard;src:url(${JSON.stringify(fontUrl)}) format("woff2");font-display:block}
:root{color-scheme:dark;font-family:FixtureDashboard,system-ui;background:#111b28;color:#ecf2fa}
body{margin:0;padding:28px}h1{font-size:28px;margin:0 0 24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
section{padding:24px;border:1px solid #304356;border-radius:16px;background:#1a293a}h2{font-size:15px;margin:0 0 18px}.value{font-size:36px}
.chart{display:flex;align-items:end;gap:10px;height:170px;margin-top:24px}.chart i{flex:1;background:#6ee7b7;border-radius:5px 5px 0 0}
</style></head><body><h1>Team metric 1</h1><div class="cards">
${[72, 85, 96].map((value, index) => `<section><h2>${["Completed work", "Service health", "Availability"][index]}</h2><div class="value">${value}%</div><div class="chart">${[43, 68, 51, 78, 64, value].map((height) => `<i style="height:${height}%"></i>`).join("")}</div></section>`).join("")}
</div><script>
document.fonts.load('16px "FixtureDashboard"').then(()=>document.fonts.ready).then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
  document.body.dataset.dashboardReady="true";
  parent.postMessage({type:"openclaw:bench-dashboard-ready",fontLoaded:[...document.fonts].some(face=>face.family==="FixtureDashboard"&&face.status==="loaded")},"*");
})));
</script></body></html>`;
}
