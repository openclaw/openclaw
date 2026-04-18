@echo off
title KASAI - OpenClaw Gateway

echo ============================================
echo   KASAI - OpenClaw Gateway
echo ============================================
echo.
echo Make sure LM Studio is running with at least
echo one model loaded and server active on :1234
echo.
echo Default model: Qwen 3.5 9B
echo Available: Gemma, Bonsai, Qwen VL 8B/4B/30B,
echo   Nemotron, GLM Flash
echo.
pause

cd /d "%~dp0"

set OPENCLAW_DISABLE_BONJOUR=1
set TOKEN=d8a30751781cf0d08537277149080d4ffdc57262d6a99aec
set GATEWAY_PORT=18789

REM -----------------------------------------------------------
REM 1. Kill any stale gateway
REM -----------------------------------------------------------
echo.
echo Checking for existing gateway...
curl -s -o nul http://127.0.0.1:%GATEWAY_PORT% >nul 2>&1
if not errorlevel 1 (
    echo   Found running gateway, stopping it...
    call pnpm openclaw gateway stop >nul 2>&1
    timeout /t 3 /nobreak >nul
)

REM -----------------------------------------------------------
REM 2. Open browser to gateway control UI (served from 18789)
REM    Token passed as fragment for WebSocket auth
REM -----------------------------------------------------------
start "" /B powershell -WindowStyle Hidden -Command "Start-Sleep 15; Start-Process 'http://127.0.0.1:18789/#token=d8a30751781cf0d08537277149080d4ffdc57262d6a99aec'"

REM -----------------------------------------------------------
REM 3. Start TUI in a separate window
REM -----------------------------------------------------------
start "KASAI TUI" /D "%~dp0" cmd /k "pnpm openclaw tui --token d8a30751781cf0d08537277149080d4ffdc57262d6a99aec"

REM -----------------------------------------------------------
REM 4. Gateway runs in foreground (keeps this window alive)
REM -----------------------------------------------------------
echo Starting OpenClaw Gateway on port %GATEWAY_PORT% (loopback only)...
echo mDNS discovery: DISABLED
echo.
echo Web UI will open at http://127.0.0.1:%GATEWAY_PORT%
echo TUI opening in separate window...
echo.

pnpm openclaw gateway run --bind loopback --port %GATEWAY_PORT% --token %TOKEN%

echo.
echo Gateway stopped.
pause
