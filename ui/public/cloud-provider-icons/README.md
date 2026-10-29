# Cloud provider marks

Bundled locally for the cloud environment picker. CSS masks render these marks in
`currentColor`, preserving the source geometry and aspect ratio in a 14 × 14 slot.
Hetzner uses 88% optical sizing inside that slot. These are cloud brands, not
model-provider marks. Generic server, box, and cloud glyphs use the shared UI icons.

## Sources and permissions

- `aws.svg`, `azure.svg`, and `gcp.svg`: [Devicon](https://github.com/devicons/devicon)
  at commit `7330accdbc47e2dc0c19789a48533c4a3c50fe58`, respectively
  `icons/amazonwebservices/amazonwebservices-plain-wordmark.svg`,
  `icons/azure/azure-plain.svg`, and `icons/googlecloud/googlecloud-plain.svg`.
  Unmodified source assets; MIT license included in `LICENSE-devicon`.
- `hetzner.svg`: [Simple Icons](https://github.com/simple-icons/simple-icons)
  at commit `f2365d33171bd1897a41aaae6c0b6e795bcc0483`, `icons/hetzner.svg`.
  Unmodified complete square/knockout-H mark; CC0 text in `LICENSE-simple-icons`.
  Simple Icons does not grant trademark rights; consult the brand guidelines.
- `daytona.svg`: [Daytona brand page](https://www.daytona.io/brand),
  [original asset](https://framerusercontent.com/images/BMS3JNoqcWhNnhvwm1sK1cnYg.svg).
  Brand-source attribution, not a claim of a general trademark license.
  The exact white presentation background
  `<path fill="#fff" d="M0 0h454v320H0z"/>` was removed. The other three path-data
  values are unchanged. Chromium `getBBox()` measured the glyph at
  x=192.354996, y=123.801010, width=68.707993, height=71.602005. The viewport is
  a centered square with side `max(width, height) * 1.08`:
  `188.043909 120.936930 77.330165 77.330165`. This is a viewport/background
  adaptation for a monochrome mask, not a redrawing of the glyph.

All brand names and marks remain the property of their respective owners.
Their inclusion identifies the configured backend and does not imply endorsement.
