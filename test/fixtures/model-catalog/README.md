# Meta/Muse identity regression sources

Captured October 17–18, 2026. These fixtures reproduce source contracts, not
current provider policy.

- `muse-meta-account.json`: original `model/list` from Muse Code 1.3.0 using
  `@muse-code/sdk` 1.4.2. Only account `profileId` values were replaced with
  `sanitized`. Full Contributor carried its sibling Contributor ID as a label.
- `muse-meta-expected.json`: accepted adapter rows asserted against that source
  response by the Muse reader test. Gateway and browser tests reuse these rows
  through real enrichment and configured `models.list` projection.
- `hosted-meta.json`: Meta IDs, labels, context windows, generation time, and
  recommendation metadata from <https://catalog.openclaw.ai/models/v2/catalog.json>.
  Unconsumed fields are omitted. The response had no OpenRouter recommendations.
- `openrouter-meta.json`: Muse IDs, canonical slugs, labels, and context windows
  from <https://openrouter.ai/api/v1/models>. Unconsumed fields are omitted.
  These rows do not establish native account access or interchangeable IDs.

Official sources distinguish capability variant from data-use mode:
<https://dev.meta.ai/docs/models#muse-wonder-availability> and
<https://dev.meta.ai/models/muse-wonder>. Credential-free official API discovery
returned HTTP 401, not an empty catalog. No authenticated Model API inventory was
obtained; native subscription discovery is not API entitlement evidence.
