# Clawdbot Control UI Makefile
# ============================

.PHONY: help install build dev preview clean lint format test build-deploy serve open

# Default target
help:
	@echo "Clawdbot Control UI - Available Commands"
	@echo "========================================="
	@echo ""
	@echo "  make install       Install dependencies"
	@echo "  make build         Build for production"
	@echo "  make dev           Start development server"
	@echo "  make dev-gateway   Dev server + proxy to running gateway"
	@echo "  make preview       Preview production build"
	@echo "  make serve         Serve production build (no browser)"
	@echo "  make open          Open UI in default browser"
	@echo "  make build-deploy  Build and launch UI in browser"
	@echo "  make clean         Remove build artifacts"
	@echo "  make lint          Run linter"
	@echo "  make format        Format code"
	@echo "  make test          Run tests"
	@echo ""

# Configuration
PORT ?= 4173
HOST ?= localhost
DIST_DIR = ../dist/control-ui
GATEWAY_URL ?= ws://127.0.0.1:18789

# Install dependencies
install:
	pnpm install

# Build for production
build:
	pnpm build

# Start development server with hot reload
dev:
	pnpm dev

# Start dev server and proxy gateway endpoints to an existing gateway instance.
# Override with: CLAWDBOT_CONTROL_UI_PROXY_TARGET=http://<host>:<port> make dev-gateway
dev-gateway:
	pnpm dev:gateway

# Preview production build (vite preview)
preview:
	pnpm preview

# Serve the production build without opening browser
serve:
	@SELECTED_PORT=$$(HOST="$(HOST)" PORT="$(PORT)" python3 scripts/select-port.py); \
		if [ "$$SELECTED_PORT" != "$(PORT)" ]; then \
			echo "Port $(PORT) already in use; using $$SELECTED_PORT"; \
		fi; \
		DIST_DIR="$(DIST_DIR)" PASSWORD="$(PASSWORD)" GATEWAY_URL="$(GATEWAY_URL)" python3 scripts/write-runtime-config.py >/dev/null; \
		echo "Starting server at http://$(HOST):$$SELECTED_PORT"; \
		DIST_DIR="$(DIST_DIR)" HOST="$(HOST)" PORT="$$SELECTED_PORT" python3 scripts/serve-dist.py

# Open UI in default browser (macOS)
open:
	@open "http://$(HOST):$(PORT)"

# Build and deploy: full build then launch UI in browser
build-deploy: build
	@echo ""
	@echo "Build complete. Starting server..."
	@echo "Opening http://$(HOST):$(PORT) in browser..."
	@echo ""
	@# Start server in background, wait for it, then open browser
	@SELECTED_PORT=$$(HOST="$(HOST)" PORT="$(PORT)" python3 scripts/select-port.py); \
		if [ "$$SELECTED_PORT" != "$(PORT)" ]; then \
			echo "Port $(PORT) already in use; using $$SELECTED_PORT"; \
		fi; \
		DIST_DIR="$(DIST_DIR)" PASSWORD="$(PASSWORD)" GATEWAY_URL="$(GATEWAY_URL)" python3 scripts/write-runtime-config.py >/dev/null; \
		DIST_DIR="$(DIST_DIR)" HOST="$(HOST)" PORT="$$SELECTED_PORT" python3 scripts/serve-dist.py & \
			SERVER_PID=$$!; \
			sleep 1; \
			open "http://$(HOST):$$SELECTED_PORT"; \
			echo "Server running (PID: $$SERVER_PID). Press Ctrl+C to stop."; \
			wait $$SERVER_PID

# Clean build artifacts
clean:
	rm -rf $(DIST_DIR)
	rm -rf node_modules/.vite

# Run linter
lint:
	pnpm lint

# Format code
format:
	pnpm format

# Run tests
test:
	pnpm test

# Run tests with coverage
test-coverage:
	pnpm test:coverage

# Type check
typecheck:
	pnpm exec tsc --noEmit

# Watch mode for development (alias)
watch: dev

# Full rebuild (clean + install + build)
rebuild: clean install build
