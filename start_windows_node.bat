@echo off
echo Starting Windows Native Swarm Node...
cd /d "%~dp0"
node scripts\docker\sidecars\windows-node.cjs
