# eMudhra trust-export regression

Public certificate data captured on October 20, 2026 from
<https://dv-g3b-emudhra.we-have-a-problem.com>, one of the demonstrations linked
from <https://emudhra.we-have-a-problem.com>. No private key is included.

`leaf.pem` is the hostname's server certificate. `untrusted.pem` contains its
issuer chain, which reaches the emSign ECC Root CA - G3 trust anchor. Independent
OpenSSL verification accepts this chain against Node's original bundled roots.
The worker regression verifies the exported process-grant bundle instead, with
server purpose, the original hostname, and a fixed time within certificate
validity. Its rejection must be a missing issuer, rather than expiration or an
unsupported verification option. A separate positive control keeps the generated
proxy CA and real synthetic-secret forwarding working.

This tests the CA-file consumer boundary independently of Node's verifier. It
does not establish that a child client's other trust stores or a bypass tunnel
reject the incident keys.
