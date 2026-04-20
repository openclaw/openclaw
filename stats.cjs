const fs = require("fs");
const events = JSON.parse(
  fs.readFileSync(process.env.HOME + "/.openclaw/cache/ghl/calendar-events.json"),
);

const targetIds = {
  "Tristan Masteller": "ujlW0c5czovW01TWKjvp",
  "Jackson Godfrey": "d8ON3WSQpxEw6C1uh3WM",
  "Mateo Weeks": "YKj8qNEgsonDpF8WSbJt",
  "Nick Greene": "Mhcs4yWQwXBtpKZRqwI6",
  "Daniel Delis": "tXIFFLPTX782dmGmuJcs",
};

console.log("Name | Feb | Mar | Apr (MTD) | Apr (Proj) | % vs Mar");
console.log("---|---|---|---|---|---");

let totFeb = 0,
  totMar = 0,
  totApr = 0;

for (const [name, id] of Object.entries(targetIds)) {
  const feb = events.filter(
    (e) => e.createdBy?.userId === id && e.dateAdded.startsWith("2026-02"),
  ).length;
  const mar = events.filter(
    (e) => e.createdBy?.userId === id && e.dateAdded.startsWith("2026-03"),
  ).length;
  const apr = events.filter(
    (e) => e.createdBy?.userId === id && e.dateAdded.startsWith("2026-04"),
  ).length;

  totFeb += feb;
  totMar += mar;
  totApr += apr;

  const proj = apr * 2;
  const pct = mar === 0 ? "N/A" : (((proj - mar) / mar) * 100).toFixed(1) + "%";
  console.log(`${name} | ${feb} | ${mar} | ${apr} | ${proj} | ${pct}`);
}
const totProj = totApr * 2;
const totPct = (((totProj - totMar) / totMar) * 100).toFixed(1) + "%";
console.log(`TOTAL | ${totFeb} | ${totMar} | ${totApr} | ${totProj} | ${totPct}`);
