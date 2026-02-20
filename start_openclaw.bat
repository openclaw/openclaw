@echo off
title OpenClaw Server
cd /d "%~dp0"
echo ===================================================
echo Starting OpenClaw...
echo ===================================================
call pnpm start
pause
