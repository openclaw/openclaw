@echo off
echo ============================================
echo   KASAI - OpenClaw Gateway + TUI Launcher
echo ============================================
echo.
echo Make sure LM Studio is running with at least one model loaded
echo and the server is active on localhost:1234
echo.
echo Default model: Qwen 3.5 9B (alias: Qwen 9B)
echo Switch in TUI: /model gemma, /model qwen vl 8b, etc.
echo.
echo Available aliases: Qwen 9B, Gemma, Bonsai, Qwen VL 8B,
echo   Qwen VL 4B, Nemotron, Qwen VL 30B, GLM Flash
echo.
pause

cd /d "%~dp0"

REM Security: disable mDNS network discovery
set OPENCLAW_DISABLE_BONJOUR=1

echo.
echo Starting OpenClaw Gateway on port 18789 (loopback only)...
echo mDNS discovery: DISABLED
start "OpenClaw Gateway" /D "%~dp0" cmd /k "set OPENCLAW_DISABLE_BONJOUR=1 && pnpm openclaw gateway run --bind loopback --port 18789"

echo Waiting for gateway to bind (checking every 10s)...
:waitloop
timeout /t 10 /nobreak >nul
curl -s -o nul -w "" http://127.0.0.1:18789 >nul 2>&1
if errorlevel 1 (
    echo   Still waiting...
    goto waitloop
)
echo Gateway is ready!

echo.
echo Starting TUI client...
echo.
pnpm openclaw tui --token d8a30751781cf0d08537277149080d4ffdc57262d6a99aec
pause
