#!/usr/bin/env pwsh
# 🐺 ALPHABET HARVESTER - Quick Test Script

Write-Host "🐺 Starting ALPHABET HARVESTER..." -ForegroundColor Green
Write-Host ""

# Start Docker Compose
Write-Host "📦 Starting Docker containers..." -ForegroundColor Cyan
Set-Location "c:\Users\finnu\Documents\GitHub\openclaw"
docker-compose up -d

# Wait for services to be ready
Write-Host ""
Write-Host "⏳ Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Check health
Write-Host ""
Write-Host "🏥 Health check..." -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "http://localhost:8080/api/health" -Method Get
    Write-Host "✅ Backend is healthy!" -ForegroundColor Green
    Write-Host "   Uptime: $($health.uptime) seconds" -ForegroundColor Gray
} catch {
    Write-Host "❌ Backend not responding yet, give it a moment..." -ForegroundColor Red
}

# Show targets
Write-Host ""
Write-Host "📋 Current targets:" -ForegroundColor Cyan
try {
    $response = Invoke-RestMethod -Uri "http://localhost:8080/api/targets" -Method Get
    Write-Host "   Workers: $($response.stats.workers)" -ForegroundColor Green
    Write-Host "   Active: $($response.stats.active)" -ForegroundColor Yellow
    Write-Host "   Completed: $($response.stats.completed)" -ForegroundColor Green
    Write-Host "   Failed: $($response.stats.failed)" -ForegroundColor Red
    Write-Host "   Total targets: $($response.targets.Count)" -ForegroundColor Cyan
} catch {
    Write-Host "   Unable to fetch targets yet..." -ForegroundColor Red
}

Write-Host ""
Write-Host "🌐 Open these URLs:" -ForegroundColor Magenta
Write-Host "   UI:      http://localhost:5173" -ForegroundColor Cyan
Write-Host "   API:     http://localhost:8080/api/targets" -ForegroundColor Cyan
Write-Host "   Logs:    ws://localhost:8080/api/logs/stream" -ForegroundColor Cyan

Write-Host ""
Write-Host "🚀 To scale workers to 10:" -ForegroundColor Yellow
Write-Host '   Invoke-RestMethod -Uri "http://localhost:8080/api/workers/scale" -Method Post -Body ''{"workers": 10}'' -ContentType "application/json"'

Write-Host ""
Write-Host "📝 To add a new target:" -ForegroundColor Yellow
Write-Host '   Invoke-RestMethod -Uri "http://localhost:8080/api/targets" -Method Post -Body ''{"url": "https://example.com/newpage"}'' -ContentType "application/json"'

Write-Host ""
Write-Host "🛑 To stop:" -ForegroundColor Red
Write-Host "   docker-compose down"

Write-Host ""
Write-Host "✅ ALL DONE! Farðu á http://localhost:5173 núna! 🎉" -ForegroundColor Green
