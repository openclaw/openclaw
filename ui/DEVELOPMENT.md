# Clawdbot Control UI (dev)

## Run UI against an existing gateway

This starts the Vite dev server, defaults the UI to `ws://127.0.0.1:18789`, and proxies gateway-owned HTTP routes (`/api`, `/avatar`) to avoid CORS issues.

- `pnpm dev:gateway`
- Override target: `CLAWDBOT_CONTROL_UI_PROXY_TARGET=http://<host>:<port> VITE_CLAWDBOT_CONTROL_UI_DEFAULT_GATEWAY_URL=ws://<host>:<port> pnpm dev:gateway`
- Optional password (still not stored): `CLAWDBOT_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD=... pnpm dev:gateway`

## `make build-deploy` with a gateway password

`make build-deploy` serves the built static UI on a local port. By default, the UI will connect to `ws://127.0.0.1:18789`.

- `make build-deploy PASSWORD='...'`
- Override gateway WS: `make build-deploy GATEWAY_URL=ws://<host>:<port> PASSWORD='...'`
