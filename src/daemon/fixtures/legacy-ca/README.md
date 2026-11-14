# Historical macOS legacy CA stock fixture

Public OpenBSD certificate bundle revision `1.22.2.1`:
<https://cvsweb.openbsd.org/src/lib/libcrypto/cert.pem?rev=1.22.2.1&content-type=text/plain>.

`openbsd-1.22.2.1.pem.gz` stores the exact source bytes in deterministic gzip
form (mtime zero) so historical text whitespace is preserved without becoming
repository whitespace errors. The tests decompress it before classification.
Decoded content: 333483 bytes; 128 certificates; SHA256
`9dae8d76e55cb08991f2b672d58999ea15560d910759c16b544f843bdffbb994`.
This independently authenticated historical source is byte-identical to the
Apple sealed system template observed on macOS 27.0.1 (26A434). Tests retain
the exact original bytes because eligibility depends on their complete prefix,
not membership in current Node or macOS root stores. No private keys.

`deny-root1.pem` and `deny-root2.pem` are public, synthetic CA certificates
with different DER fingerprints and the same SPKI
`913ff4a94a3130cabf6ebf84fdf48cf107b3080779b8f541f1940010612487dc`.
They protect policy-scoped native distrust across alternate certificates;
native policy evaluation is separately controlled in this unit scenario.
Their short validity is irrelevant to the key-identity contract, and they
must not be used for live TLS qualification. No private key is included.

`ec-named-root.pem` and `ec-explicit-root.pem` are synthetic self-signed
P-384 certificates sharing a key, with different SubjectPublicKeyInfo curve
encodings. They protect cryptographic key identity across named and explicit
EC parameters. Like the deny fixtures, native policy is controlled independently;
these certificates must not be used for live TLS qualification.
