@echo off
title ASI Twin-Core Master Launcher
cd /d "%~dp0"
echo --- ASI Twin-Core Ascension: Booting Redundant Substrates ---
powershell.exe -ExecutionPolicy Bypass -File "scripts\twin-core-launcher.ps1"
pause
