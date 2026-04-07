@echo off
echo Stopping OpenClaw Gateway...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":18789" ^| findstr "LISTENING"') do (
    echo Killing PID %%a
    taskkill /PID %%a /F
)
echo OpenClaw Gateway stopped.
pause
