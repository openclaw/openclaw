#!/bin/bash
# Инициализация и запуск OpenClaw Gateway в среде WSL 2 с поддержкой Webhook

# Автоматически определяем IP Windows хоста для сети WSL2 (наиболее надежный метод)
WIN_HOST_IP=$(ip route show | grep -i default | awk '{ print $3 }')
export OLLAMA_HOST="${WIN_HOST_IP:-192.168.0.212}:11434"
export WSL_ENV="1"

echo "==========================================="
echo "🚀 Starting OpenClaw Python Backend in WSL2"
echo "📡 OLLAMA_HOST is set to ${OLLAMA_HOST}"
echo "==========================================="

# Проверка системных пакетов
if ! command -v python3 &> /dev/null || ! python3 -m venv --help &> /dev/null; then
    echo "📦 Отсутствует Python 3 или модуль venv. Установка (потребуется sudo пароль от WSL)..."
    sudo apt-get update -q
    sudo apt-get install -y python3 python3-venv python3-pip
fi

# Проверяем, существует ли виртуальное окружение, если нет - создаем
if [ ! -d "venv" ]; then
    echo "📦 Создание виртуального окружения (venv)..."
    python3 -m venv venv
fi

# Активируем виртуальное окружение
source venv/bin/activate

# Обновляем пакеты, если нужно 
echo "🔄 Установка зависимостей..."
pip install --upgrade pip -q
pip install aiogram aiohttp psutil pydantic structlog watchdog aiosqlite prometheus-client scikit-learn pandas websockets -q

# --- НАСТРОЙКА DNS (Критично для работы туннелей в WSL2) ---
echo "🛠️ Настройка DNS..."
# Удаляем старый resolv.conf если это ссылка и создаем новый статический
sudo rm -f /etc/resolv.conf
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf > /dev/null
echo "nameserver 1.1.1.1" | sudo tee -a /etc/resolv.conf > /dev/null
# Запрещаем автоматическое перезаписывание (опционально, но полезно)
# sudo chattr +i /etc/resolv.conf 2>/dev/null || true

# --- НАСТРОЙКА WEBHOOK СЕРВЕРА ---
pkill -f cloudflared
pkill -f ngrok
rm -f cloudflared.log ngrok.log

# Функция для запуска Cloudflare
start_cloudflare() {
    if [ ! -f "cloudflared" ]; then
        echo "☁️ Скачивание Cloudflare Tunnel..."
        wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared
        chmod +x cloudflared
    fi
    echo "🌐 Запуск Cloudflare Tunnel..."
    ./cloudflared tunnel --edge-ip-version 4 --protocol http2 --url http://localhost:8080 > cloudflared.log 2>&1 &
    
    for i in {1..15}; do
        sleep 1
        PUBLIC_URL=$(grep -o 'https://[-a-zA-Z0-9]*\.trycloudflare\.com' cloudflared.log | grep -v 'api.trycloudflare.com' | head -1)
        if [ -n "$PUBLIC_URL" ]; then
            echo "✅ Cloudflare Webhook URL: ${PUBLIC_URL}"
            return 0
        fi
    done
    return 1
}

# Функция для запуска Ngrok
start_ngrok() {
    if ! command -v ngrok &> /dev/null; then
        echo "🌀 Установка ngrok (fallback)..."
        curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
        echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list >/dev/null
        sudo apt-get update -v -q
        sudo apt-get install -y ngrok -q
    fi
    echo "🌐 Запуск ngrok..."
    ngrok http 8080 --log=stdout > ngrok.log 2>&1 &
    
    for i in {1..15}; do
        sleep 1
        PUBLIC_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[-a-zA-Z0-9.]*\.ngrok-free\.app' | head -1)
        if [ -n "$PUBLIC_URL" ]; then
            echo "✅ Ngrok Webhook URL: ${PUBLIC_URL}"
            return 0
        fi
    done
    return 1
}

# Пытаемся запустить провайдеров
if start_cloudflare; then
    export USE_WEBHOOK=1
elif start_ngrok; then
    export USE_WEBHOOK=1
else
    echo "⚠️ Не удалось поднять туннель (проверьте интернет)."
    echo "Будет использован Long-Polling."
    export USE_WEBHOOK=0
fi

if [ "$USE_WEBHOOK" -eq 1 ]; then
    export WEBHOOK_URL="${PUBLIC_URL}/webhook"
fi

echo "==========================================="
echo "🧠 Loading 20 Specialized Roles via Config..."
echo "⚙️ Нажмите Ctrl+C для Graceful Shutdown"
echo "==========================================="

# Запуск бота 
python3 main.py

# Очистка
echo "🛑 Остановка туннелей..."
pkill -f cloudflared
pkill -f ngrok
echo "✅ Завершено!"
