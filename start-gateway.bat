@echo off
cd /d "%~dp0"
set OPENCLAW_DISABLE_BONJOUR=1
pnpm openclaw gateway run --bind loopback --port 18789
