# Released notification preference fixture

`openclaw-2026.10.2.sql` is a complete SQLite dump created by the published
OpenClaw **2026.10.2** production profile owner and `push.web.subscribe`,
`push.web.preferences.set`, and `push.web.preferences.get` handlers. npm's
`latest` tag pointed to this release when verified on 2026-10-13.

The synthetic state contains a Detailed account, a browser inheriting that
account, a browser with an explicit Detailed override, and an untouched default
account/browser. Neither released normalizer knows preview consent. The full
schema is retained so the candidate's real schema admission runs from v20;
preferences are not inserted into a candidate-created database.

Provenance: [published tarball](https://registry.npmjs.org/openclaw/-/openclaw-2026.10.2.tgz),
SHA-1 `27956be5ad49487209be231788fe6b89835185c9`,
SHA-512 `FuLLF+WI12ypwQ0r+pcKDcmB+kXus5N4QClaKEnaAn6GN4I1AitkOhwv0GFl2rVKpvuUBDQWIfglHNy6Trv/EQ==`.
The fixture uses only synthetic identities and push keys. SQLite integrity and
foreign-key checks passed after reconstructing the dump. `PRAGMA user_version=20`
is preserved separately because SQLite's `.dump` omits it.

To regenerate from the repository with Node 26 and `sqlite3` on PATH:

```sh
producer=$(mktemp -d)
curl -fsSL https://registry.npmjs.org/openclaw/-/openclaw-2026.10.2.tgz -o "$producer/release.tgz"
shasum -a 1 "$producer/release.tgz" # Must match the SHA-1 above.
tar -xzf "$producer/release.tgz" -C "$producer"
npm install --prefix "$producer/package" --ignore-scripts --no-audit --no-fund
node test/fixtures/push-preferences-upgrade/produce.mjs "$producer/package" "$producer/state"
```

The producer calls the exact bundled exports of this pinned release. Regeneration
changes random profile/subscription IDs and timestamps; the test discovers the
synthetic device bindings rather than depending on those random values.

The captured run used released application/worker code and pinned
`@openclaw/ai@2026.10.2`, with remaining dependencies resolved from the prepared
workspace. This proves the persisted upgrade contract; it is not a clean-install
or whole-Gateway update smoke test. The candidate test uses production schema
admission and RPC handlers, including worker storage, unrelated saves, explicit
consent, and database close/reopen. Delivery behavior has its own owning-boundary
tests.
